import packageInfo from '../../package.json' with {type:'json'};
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { z } from 'zod';
import { agentDraftSchema, observationSchema } from '../core/store.js';
import { efforts, PROVIDER_MODEL_SUGGESTIONS, CLAUDE_EFFORT_LEVELS } from '../shared/effort.js';
import { ACCOUNT_STALE_MS, LOCAL_ACCOUNT_STALE_MS } from '../shared/readiness.js';
import type { Effort, Agent, AgentTicket, Connection, Provider, UsageWindow } from '../shared/types.js';
export type AccountObservation=z.infer<typeof observationSchema>;

export const providerSchema=z.enum(['openai','claude','devin']);
const PROVIDER_EXECUTABLE:Record<Provider,string>={openai:'codex.exe',claude:'claude.exe',devin:'devin.exe'};
const PROVIDER_TOOL_NAME:Record<Provider,string>={openai:'Codex',claude:'Claude Code',devin:'Devin'};
/**
 * Which official tool a sign-in window belongs to and which account is re-checked after it.
 * OpenAI signs in through the Codex app-server browser flow, not a terminal login command, so it has
 * no entry here; every other provider's window is its own executable running `auth login`, and the
 * same provider's status is what verifies the result.
 */
export function providerLogin(provider:Provider):{provider:Provider;executable:string;args:string[]}|null {
 return provider==='openai'?null:{provider,executable:PROVIDER_EXECUTABLE[provider],args:['auth','login']};
}
/** Reads `devin models list --format json`: family objects and variant objects ({model_uid,label}) alike.
 * Variant entries additionally record their family and the effort level their uid encodes —
 * Devin has no separate effort axis; the variant suffix IS the effort selector. */
export function devinModelCatalog(parsed:unknown):Connection['models'] {
 const models:Connection['models']=[];
 const source='Installed Devin CLI models list --format json; cloud application unverified';
 const normalize=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
 const variantEffort=(family:string,variant:string,label:string):Effort|undefined=>{
  const fam=normalize(family),uid=normalize(variant);
  if(!fam||!uid)return undefined;
  const suffix=uid===fam?'':uid.startsWith(fam+'-')?uid.slice(fam.length+1):undefined;
  if(suffix===undefined)return undefined;
  const token=suffix.endsWith('-fast')?suffix.slice(0,-5):suffix;
  if(token&&efforts.includes(token as Effort))return token as Effort;
  if(!token&&/\bmax$/i.test(label))return 'max';
  return undefined;
 };
 const displayName=(node:any,id:string)=>typeof node.displayName==='string'?node.displayName:typeof node.family_label==='string'?node.family_label:typeof node.name==='string'?node.name:typeof node.label==='string'?node.label:id;
 const collect=(node:any,family?:{id:string;efforts:Effort[]}):void=>{
  if(Array.isArray(node)){node.forEach(child=>collect(child,family));return;}
  if(!node||typeof node!=='object')return;
  const id=node.id??node.slug??node.name??node.model_uid;
  if(typeof id==='string'&&id&&models.length<512&&!models.some(m=>m.id===id)){
   const entry:Connection['models'][number]={id,name:displayName(node,id),source};
   if(family){entry.family=family.id;const effort=variantEffort(family.id,id,displayName(node,id));if(effort)entry.effort=effort;if(family.efforts.length)entry.efforts=['default',...family.efforts];}
   models.push(entry);
  }
  if(Array.isArray(node.variants)){
   const familyId=typeof id==='string'&&id?id:normalize(String(node.family_uid??node.slug??''));
   const variants:any[]=node.variants.filter((v:any)=>v&&typeof v==='object');
   const set:Effort[]=[...new Set(variants.map(v=>variantEffort(familyId,String(v.model_uid??v.id??v.slug??v.name??''),displayName(v,''))).filter((e):e is Effort=>!!e))];
   const childFamily={id:familyId,efforts:set};
   for(const v of variants)collect(v,childFamily);
   for(const [key,value] of Object.entries(node))if(key!=='variants')collect(value);
   return;
  }
  Object.values(node).forEach(value=>collect(value,family));
 };
 collect(parsed);
 return models;
}
const allowedMethods=new Set(['initialize','account/read','account/login/start','account/login/cancel','account/rateLimits/read','model/list']);
export function subscriptionEnvironment(): NodeJS.ProcessEnv {
 const env={...process.env};
 // ACP_* describes the agent-client shell that spawned this process (e.g. ACP_BACKEND=windsurf), not
 // a provider login; left in place it makes checks such as `devin auth status` misreport sign-in state.
 for(const key of Object.keys(env))if(/^(ACP_|OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|CODEX_API_KEY|DEVIN_API_KEY|DEVIN_TOKEN|DEVIN_AUTH_TOKEN)/i.test(key))delete env[key];
 return env;
}
export function usageWindows(raw: any): UsageWindow[] {
 const buckets=raw?.rateLimitsByLimitId ?? (raw?.rateLimits?{codex:raw.rateLimits}:{}),result:UsageWindow[]=[];
 for(const [name,bucket] of Object.entries(buckets) as [string,any][]){
  for(const key of ['primary','secondary']){const w=bucket?.[key];if(!w||!Number.isFinite(w.usedPercent)||!Number.isFinite(w.windowDurationMins)||!Number.isFinite(w.resetsAt))continue;
   const duration=w.windowDurationMins===300?'5 hour':w.windowDurationMins===10080?'Weekly':`${w.windowDurationMins} minute`;
   result.push({label:`${bucket.limitName||name} · ${duration}`,remainingPercent:Math.max(0,Math.min(100,100-w.usedPercent)),resetsAt:w.resetsAt});
  }
 }return result;
}
export function claudeIdentity(raw:any):string {
 if(raw?.loggedIn!==true||raw.authMethod!=='claude.ai'||typeof raw.subscriptionType!=='string'||!raw.subscriptionType||typeof raw.email!=='string'||!raw.email)throw new Error('Claude Code must report a signed-in Claude subscription. Console/API accounts cannot be added.');
 return raw.email;
}
/**
 * The account a `devin auth status` report belongs to, or '' when the tool did not identify one.
 * A signed-in session without an account is an *unidentified* context — the status line itself
 * (e.g. "Logged in (via Devin).") is never an identity and must not mint one.
 */
export function devinStatusIdentity(raw:string):string {
 if(/not logged in/i.test(raw))return '';
 const labeled=raw.match(/^\s*Email:\s*([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\s*$/im)?.[1];
 return labeled??raw.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0]??'';
}
class CodexMetadata {
 /** When this process started; an auth file newer than this is evidence the in-process answer may be stale. */
 readonly spawnedAt=Date.now();
 private child:ChildProcessWithoutNullStreams;
 private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private sequence=0;
 private buffer='';
 private closed=false;
 private ready:Promise<void>;
 constructor(executable:string,cwd:string){
  this.child=spawn(executable,['app-server','--listen','stdio://'],{cwd,env:subscriptionEnvironment(),windowsHide:true,stdio:'pipe'});
  this.child.stderr.resume();
  this.child.on('error',()=>this.stop());this.child.on('exit',()=>this.stop());
  this.child.stdout.on('data',chunk=>{this.buffer+=chunk.toString();if(this.buffer.length>4*1024*1024){this.stop();return;}let index;while((index=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);try{const message=JSON.parse(line);if(message.method&&message.id!==undefined){this.child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'This client supports account metadata only'}})+'\n');continue;}const item=this.pending.get(message.id);if(item){clearTimeout(item.timer);this.pending.delete(message.id);message.error?item.reject(new Error('Codex account operation failed. Check the official sign-in and retry.')):item.resolve(message.result);}}catch{}}});
  this.ready=this.call('initialize',{clientInfo:{name:'quant_research_office',title:'Quant Research Office',version:packageInfo.version}}).then(()=>{this.child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');});
 }
 private call(method:string,params:unknown):Promise<any>{
  if(!allowedMethods.has(method))return Promise.reject(new Error('Only account metadata operations are allowed.'));
  if(this.closed)return Promise.reject(new Error('Codex connection closed. Retry connection.'));
  return new Promise((resolve,reject)=>{const id=++this.sequence;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex account request timed out.'));},30000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});
 }
 async request(method:string,params:unknown={}){await this.ready;return this.call(method,params);}
 stop(){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Codex account connection ended. Retry.'));}this.pending.clear();this.child.kill();}
}
export class Subscriptions {
 private paths:Partial<Record<Provider,string>>={};
 private versions=new Map<string,string>();
 private codex?:CodexMetadata;
 private ticket?:AgentTicket;
 private generation=0;
 private loginProcess?:ReturnType<typeof spawn>;
 private loginId?:string;
 private connecting=false;
 constructor(private root:string,private openBrowser:(url:string)=>Promise<void>,
  /**
   * The most recent recorded SIGNED_IN observation that named an account for this provider,
   * supplied by the durable store. A live check that verifies sign-in but cannot name the account
   * (a transient identity-fetch failure) falls back to this record — inside the scope's staleness
   * window only, so a hiccup never zeroes a still-fresh recorded identity and a stale one is never
   * silently trusted.
   */
  private recordedAccount?:(provider:Provider)=>{identity:string;lastCheckedAt:string}|undefined){
  mkdirSync(root,{recursive:true});
  try{this.paths=z.object({openai:z.string().optional(),claude:z.string().optional(),devin:z.string().optional()}).strict().parse(JSON.parse(readFileSync(path.join(root,'provider-tools.json'),'utf8')));}catch{}
 }
 private executable(provider:Provider):string {
  const name=PROVIDER_EXECUTABLE[provider];
  const selected=this.paths[provider];if(selected&&existsSync(selected))return selected;
  const candidates=(process.env.PATH||'').split(path.delimiter).filter(Boolean).map(p=>path.join(p,name));
  if(process.env.USERPROFILE)candidates.push(path.join(process.env.USERPROFILE,'.local','bin',name));
  if(provider==='openai'&&process.env.LOCALAPPDATA){
   const installed=path.join(process.env.LOCALAPPDATA,'OpenAI','Codex','bin');
   try{candidates.push(...readdirSync(installed,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>path.join(installed,d.name,name)).filter(p=>existsSync(p)).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs));}catch{}
  }
  if(provider==='openai'&&process.env.APPDATA){
   // npm-installed Codex hides the real exe inside the platform package — PATH only carries the
   // codex/codex.cmd/codex.ps1 shims. Walk vendor/<triple>/bin under the default global prefix.
   const vendor=path.join(process.env.APPDATA,'npm','node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor');
   try{candidates.push(...readdirSync(vendor,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>path.join(vendor,d.name,'bin',name)).filter(p=>existsSync(p)));}catch{}
  }
  if(provider==='devin'&&process.env.LOCALAPPDATA)candidates.push(path.join(process.env.LOCALAPPDATA,'Programs','Devin',name));
  const found=candidates.find(p=>existsSync(p));if(!found)throw new Error(`${PROVIDER_TOOL_NAME[provider]} is not installed or could not be found. Install the official tool, then use Locate sign-in tool to select ${name}.`);return found;
 }
 select(provider:Provider,executable:string){
  if(!path.isAbsolute(executable)||path.basename(executable).toLowerCase()!==PROVIDER_EXECUTABLE[provider]||!existsSync(executable))throw new Error('Select the official provider executable.');
  this.cancel();this.codex?.stop();this.codex=undefined;this.versions.clear();this.paths[provider]=executable;writeFileSync(path.join(this.root,'provider-tools.json'),JSON.stringify(this.paths));
 }
 /** The official executable the office would run. Located here, never supplied by the renderer. */
 toolPath(provider:Provider):string{return this.executable(provider);}
 private client(){return this.codex??=this.spawnCodex();}
 private spawnCodex(){return new CodexMetadata(this.executable('openai'),this.root);}
 /** The durable OpenAI sign-in record; its mtime is evidence the in-process answer may be stale. */
 private authFile(){return path.join(process.env.CODEX_HOME??path.join(homedir(),'.codex'),'auth.json');}
 /** One full account read against a given app-server: account, catalog and usage, each honestly degraded. */
 private async openAiConnection(client:CodexMetadata):Promise<Connection>{
  const connection:Connection={provider:'openai',connected:false,account:'',models:[],windows:[],checkedAt:new Date().toISOString(),note:''};
  // A plain read is non-mutating; a forced refresh rotates the stored token on every call, and
  // rotations racing between processes can invalidate an otherwise working grant. The refresh
  // attempt stays — as a one-off recovery path when the plain read reports nothing.
  let raw=await client.request('account/read',{refreshToken:false});
  if(raw.account?.type!=='chatgpt'){try{raw=await client.request('account/read',{refreshToken:true});}catch{}}
  if(raw.account?.type!=='chatgpt'){connection.note=raw.account?.type==='apikey'?'Sign in with a ChatGPT subscription. API authentication is not accepted.':'No ChatGPT subscription sign-in was reported by the official tool. Sign in with a ChatGPT account.';return connection;}
  connection.account=z.string().min(1).max(160).parse(raw.account.email);connection.connected=true;
  let cursor:string|null=null;const seen=new Set<string>();
  // A catalog failure must not discard the verified account, and a mid-pagination throw must not
  // leave a silently truncated catalog: the honest outcome is an empty list plus a note.
  try{do{const result:any=await client.request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});for(const model of result.data??[])if(typeof model.id==='string'&&typeof model.displayName==='string')connection.models.push({id:model.id,name:model.displayName,efforts:['default',...(model.supportedReasoningEfforts??[]).map((e:any)=>e.reasoningEffort).filter((e:any)=>efforts.includes(e)&&e!=='default')],defaultEffort:efforts.includes(model.defaultReasoningEffort)?model.defaultReasoningEffort:undefined,effortDescriptions:(model.supportedReasoningEfforts??[]).filter((e:any)=>efforts.includes(e.reasoningEffort)&&typeof e.description==='string').map((e:any)=>({effort:e.reasoningEffort,description:e.description})),source:'Installed Codex app-server model/list; cloud application unverified'});cursor=result.nextCursor??null;if(cursor&&seen.has(cursor))throw new Error('Repeated model catalog page');if(cursor)seen.add(cursor);}while(cursor);}catch{connection.models=[];connection.note='Codex model catalog unavailable. Refresh to retry.';}
  try{connection.windows=usageWindows(await client.request('account/rateLimits/read'));}catch{if(!connection.note)connection.note='Usage unavailable from Codex. Refresh to retry.';}
  if(!connection.windows.length&&!connection.note)connection.note='Usage unavailable from Codex for this account.';
  return connection;
 }
 async status(provider:Provider):Promise<Connection>{
  const connection:Connection={provider,connected:false,account:'',models:[],windows:[],checkedAt:new Date().toISOString(),note:''};
  if(provider==='openai'){
   try{
    let result=await this.openAiConnection(this.client());
    if(!result.connected&&!this.loginId&&this.codex?.spawnedAt){
     // A long-lived app-server can keep serving the account snapshot it had at spawn. If the
     // durable auth file changed after this process started, its answer is provably suspect —
     // re-read once on a fresh process. Never while this process owns a live login listener:
     // a pending OAuth callback would die with it.
     let authMoved=0;try{authMoved=statSync(this.authFile()).mtimeMs;}catch{}
     if(authMoved>this.codex.spawnedAt){this.codex.stop();this.codex=undefined;result=await this.openAiConnection(this.client());}
    }
    return result;
   }catch(error){this.codex?.stop();this.codex=undefined;throw error;}
  }else if(provider==='devin'){
   const run=(args:string[])=>new Promise<{stdout:string;failed:boolean}>((resolve,reject)=>execFile(this.executable('devin'),args,{cwd:this.root,env:subscriptionEnvironment(),windowsHide:true,timeout:30000,maxBuffer:1024*1024},(error,stdout)=>{if(error&&!stdout){reject(new Error('Devin CLI unavailable. Update the official tool and retry.'));return;}resolve({stdout,failed:Boolean(error)});}));
   let status=await run(['auth','status']),raw=status.stdout;
   // The Email: line rides on a GetUserStatus fetch that can fail while sign-in itself is fine —
   // a signed-in report with no identity gets one retry before the office settles for unidentified.
   if(!/not logged in/i.test(raw)&&!devinStatusIdentity(raw)){
    await new Promise(resolve=>setTimeout(resolve,750));
    status=await run(['auth','status']);raw=status.stdout;
   }
   if(/not logged in/i.test(raw)){connection.note='Sign in through the Devin CLI (devin auth login). The Devin Desktop session is a separate credential.';return connection;}
   const identity=devinStatusIdentity(raw);
   if(identity)connection.account=z.string().min(1).max(160).parse(identity);
   connection.connected=true;
   try{
    connection.models=devinModelCatalog(JSON.parse((await run(['models','list','--format','json'])).stdout));
   }catch{connection.note='Devin model catalog unavailable. Refresh to retry.';}
   if(!identity)connection.note=`The Devin CLI reported a signed-in session but did not identify the account${status.failed?', and the check exited with an error — its output may be incomplete':''}. The office cannot verify which account is signed in; re-check, or sign in with devin auth login so the tool reports the account.${connection.models.length?'':' Model catalog is also unavailable.'}`;
   else if(!connection.note)connection.note='Devin CLI sign-in verified. Model entitlement has not been tested. Local sessions only; no usage windows are tracked.';
  }else{
   const raw=await new Promise<string>((resolve,reject)=>execFile(this.executable('claude'),['auth','status'],{cwd:this.root,env:subscriptionEnvironment(),windowsHide:true,timeout:30000,maxBuffer:1024*1024},(error,stdout)=>{if(error&&!stdout){reject(new Error('Claude Code status unavailable. Update the official tool and retry.'));return;}resolve(stdout);}));
   try{connection.account=claudeIdentity(JSON.parse(raw));connection.connected=true;}catch{connection.note='Sign in through Claude Code with a Claude subscription.';return connection;}
   // The effort axis comes from the CLI's own `--effort` enum — a session-level preference the
   // provider applies per its own rules, not a per-model entitlement the office verified.
   connection.models=PROVIDER_MODEL_SUGGESTIONS.claude.map(m=>({...m,efforts:['default',...CLAUDE_EFFORT_LEVELS] as Effort[],source:'Claude Code --effort flag enum (claude.exe rejects other values)'}));
   connection.note='Account sign-in verified. Model entitlement has not been tested. Automatic usage retrieval is unavailable; open Claude usage to see the official limits.';
  }
  return connection;
 }
 /** Official tool version, used to bind capability evidence to the exact executable that produced it. */
 async version(provider:Provider):Promise<string>{
  const executable=this.executable(provider);const cached=this.versions.get(executable);if(cached)return cached;
  const raw=await new Promise<string>(resolve=>execFile(executable,['--version'],{cwd:this.root,env:subscriptionEnvironment(),windowsHide:true,timeout:20000,maxBuffer:64*1024},(error,stdout)=>resolve(error&&!stdout?'':String(stdout))));
  const value=raw.split('\n')[0]?.trim().slice(0,120)||'unknown';this.versions.set(executable,value);return value;
 }
 /**
  * One account check plus the durable observation derived from it.
  * Only operations this check actually exercised are OBSERVED; everything else is DOCUMENTED reference
  * material with an exact source, and can never enable an action on its own.
  */
 async observe(provider:Provider):Promise<{connection:Connection;observation:AccountObservation}>{
  const connection=await this.status(provider);
  let toolVersion='unknown';try{toolVersion=await this.version(provider);}catch{}
  const at=connection.checkedAt;
  const observed=(operation:AccountObservation['operations'][number]['operation'],level:'ACCOUNT_VERIFIED'|'UNAVAILABLE',detail:string,source:string)=>({operation,level,detail,evidence:'OBSERVED' as const,verifiedAt:at,source});
  const documented=(operation:AccountObservation['operations'][number]['operation'],level:'DOCUMENTED'|'TOOL_SUPPORTED'|'UNAVAILABLE'|'UNKNOWN',detail:string,source:string)=>({operation,level,detail,evidence:'DOCUMENTED' as const,verifiedAt:at,source});
  const accountSource=provider==='openai'?'codex app-server account/read':provider==='devin'?'devin auth status':'claude auth status';
  const operations:AccountObservation['operations']=[
   observed('ACCOUNT_STATUS',connection.connected&&connection.account?'ACCOUNT_VERIFIED':'UNAVAILABLE',connection.connected?(connection.account?'Official tool reported a signed-in subscription for this account.':'Official tool reported a signed-in session but did not identify the account.'):connection.note||'No signed-in subscription reported.',accountSource),
   provider==='claude'
    ?documented('MODEL_CATALOG','TOOL_SUPPORTED','Claude Code model aliases are built into this application. They were not read from the tool and are not an entitlement check for this account.','application alias list')
    :observed('MODEL_CATALOG',connection.models.length?'ACCOUNT_VERIFIED':'UNAVAILABLE',connection.models.length?`Catalog of ${connection.models.length} models returned by the official tool for this account.`:'No catalog returned for this account.',provider==='openai'?'codex app-server model/list':'devin models list --format json'),
   provider==='openai'
    ?observed('ALLOWANCE_READ',connection.windows.length?'ACCOUNT_VERIFIED':'UNAVAILABLE',connection.windows.length?`${connection.windows.length} rate-limit windows read for this account.`:connection.note||'Usage unavailable for this account.','codex app-server account/rateLimits/read')
    :provider==='devin'
    ?documented('ALLOWANCE_READ','UNAVAILABLE','The Devin CLI reports no usage windows to this application; local-session limits are outside this check.','devin auth status')
    :documented('ALLOWANCE_READ','UNAVAILABLE','Automatic Claude allowance retrieval is unavailable from the installed tool; the official usage page is the only source.','https://claude.ai/settings/usage'),
  ];
  if(provider==='claude')operations.push(
   documented('CLOUD_SUBMIT','DOCUMENTED','Documented: --cloud creates a session. The installed CLI refuses it over a pipe and requires an interactive terminal. Not exercised by this check.','https://code.claude.com/docs/en/cli-reference'),
   documented('CLOUD_OBSERVE','DOCUMENTED','Documented for the web session view. No supported programmatic observation has been established for this account.','https://code.claude.com/docs/en/claude-code-on-the-web'),
   documented('CLOUD_FOLLOW_UP','DOCUMENTED','Documented: -p with --cloud <session-id> returns a delivery result. A delivery receipt is not an agent reply.','https://code.claude.com/docs/en/cli-reference'),
   documented('CLOUD_OUTPUT_FETCH','UNKNOWN','No supported route for retrieving cloud job output has been established for this account.',accountSource),
   documented('CLOUD_CANCEL_REQUEST','UNKNOWN','No supported cloud cancellation route has been established. Local background-agent stop is not cloud cancellation.',accountSource),
   documented('CLOUD_CANCEL_ACK','UNKNOWN','No provider cancellation acknowledgement has ever been observed.',accountSource),
   documented('MODEL_APPLICATION','UNKNOWN','The model a cloud job actually applies has not been observed for this account.',accountSource),
   documented('EFFORT_APPLICATION','UNKNOWN','The effort a cloud job actually applies has not been observed for this account.',accountSource),
   documented('ENVIRONMENT_IDENTITY','UNKNOWN','The identity of the execution environment used by a cloud job has not been observed. A managed-host request is not verified host identity.',accountSource),
   documented('DELEGATION_CONTROL','UNKNOWN','No verified provider control disables native delegation. A prompt asking an agent not to delegate is not proof.',accountSource),
  );
  else for(const operation of ['CLOUD_SUBMIT','CLOUD_OBSERVE','CLOUD_FOLLOW_UP','CLOUD_OUTPUT_FETCH','CLOUD_CANCEL_REQUEST','CLOUD_CANCEL_ACK','MODEL_APPLICATION','EFFORT_APPLICATION','ENVIRONMENT_IDENTITY','DELEGATION_CONTROL'] as const)
   operations.push(documented(operation,'UNAVAILABLE','No provider-hosted execution transport is available for this tool.',accountSource));
  if(provider==='devin')for(const operation of ['LOCAL_SUBMIT','LOCAL_OBSERVE','LOCAL_OUTPUT_FETCH','LOCAL_CANCEL','TOOL_CONFINEMENT'] as const)
   operations.push(documented(operation,'UNKNOWN','No local session transport has been exercised for this tool yet. A signed-in CLI is not proof a local session can run.',accountSource));
  return {connection,observation:{
   provider,identity:connection.account,credentialContext:provider==='openai'?'codex-cli':provider==='devin'?'devin-cli':'claude-code-cli',
   state:connection.connected?'SIGNED_IN':'SIGNED_OUT',allowance:connection.windows,note:connection.note,
   toolVersion,transport:'NONE',environment:'',
   models:connection.models.map(model=>({id:model.id,name:model.name,...(model.efforts?{efforts:model.efforts}:{}),...(model.defaultEffort?{defaultEffort:model.defaultEffort}:{}),...(model.effortDescriptions?.length?{effortDescriptions:model.effortDescriptions}:{}),...(model.family?{family:model.family}:{}),...(model.effort?{effort:model.effort}:{}),...(model.source?{source:model.source}:{})})),
   operations,source:accountSource,
   observedAt:at,
  }};
 }
 validateEffort(provider:Provider,model:string,effort:Effort,connection?:Connection):void {
  if(effort==='default')return;
  // Claude's model input is free-text: an unlisted id still gets the session-level effort enum
  // the CLI publishes. OpenAI/Devin stay strict — an unlisted model offers only Provider default.
  const supported=connection?.provider===provider?(connection.models.find(m=>m.id===model)?.efforts??(provider==='claude'?['default',...CLAUDE_EFFORT_LEVELS]:['default'])):['default'];
  if(!supported.includes(effort))throw new Error('This effort level is not supported by the selected model. Refresh model options or choose Default.');
 }
 /**
  * The account the office may honestly name when a live check verified sign-in but could not
  * identify it: the still-fresh recorded identity for this provider, inside the staleness window
  * this scope already uses (LOCAL reads stay fresh longer than hosted ones). Returns '' when no
  * such record exists — the caller keeps its refusal.
  */
 private recordedIdentity(provider:Provider,localScope:boolean):string {
  const recorded=this.recordedAccount?.(provider);
  if(!recorded?.identity)return '';
  return Date.now()-Date.parse(recorded.lastCheckedAt)<=(localScope?LOCAL_ACCOUNT_STALE_MS:ACCOUNT_STALE_MS)?recorded.identity:'';
 }
 async connect(input:unknown):Promise<AgentTicket>{
  if(this.connecting)throw new Error('Another sign-in is already in progress. Cancel it first.');
  const draft=agentDraftSchema.parse(input);this.connecting=true;this.ticket=undefined;const generation=++this.generation;
  try{
   const connection=await this.runLogin(draft.provider,generation);
   if(!connection.account&&connection.connected){
    const recorded=this.recordedIdentity(draft.provider,(draft.execution??'HOSTED_SETUP_REQUIRED')==='LOCAL');
    if(recorded){connection.account=recorded;connection.note=`${connection.note} This check verified sign-in but could not name the account, so the bound identity is the still-fresh recorded one.`.trim();}
   }
   if(!connection.account)throw new Error(`The official ${PROVIDER_TOOL_NAME[draft.provider]} reported a signed-in session but did not identify the account. A profile cannot be bound to an unidentified session — sign in so the tool reports the account.`);
   if((draft.provider==='openai'||draft.provider==='devin')&&!connection.models.some(m=>m.id===draft.model))throw new Error(`The selected model is not in your available ${PROVIDER_TOOL_NAME[draft.provider]} catalog. Refresh models and select again.`);
   this.validateEffort(draft.provider,draft.model,draft.effort??'default',connection);
   this.ticket={id:randomUUID(),draft,connection,expiresAt:Date.now()+10*60*1000};return structuredClone(this.ticket);
  }finally{this.connecting=false;this.loginProcess=undefined;this.loginId=undefined;}
 }
 /**
  * A provider-level sign-in outside the add-agent flow: runs the provider's official login
  * (browser flow for OpenAI, the official login terminal elsewhere) and reports the verified
  * connection. No draft, model or effort is checked — this is account sign-in only.
  */
 async signIn(provider:Provider):Promise<Connection>{
  if(this.connecting)throw new Error('Another sign-in is already in progress. Cancel it first.');
  this.connecting=true;const generation=++this.generation;
  try{return await this.runLogin(provider,generation);}
  finally{this.connecting=false;this.loginProcess=undefined;this.loginId=undefined;}
 }
 /** The official sign-in for one provider, shared by connect() and the standalone sign-in. */
 private async runLogin(provider:Provider,generation:number):Promise<Connection>{
  let connection=await this.status(provider);
  if(!connection.connected){
   if(provider==='openai'){
    const result=await this.client().request('account/login/start',{type:'chatgpt'});this.loginId=result.loginId;
    const url=new URL(result.authUrl);if(url.protocol!=='https:'||!['auth.openai.com','chatgpt.com','auth.chatgpt.com'].includes(url.hostname))throw new Error('Unexpected provider sign-in URL.');
    await this.openBrowser(url.href);
    const loginStartedAt=Date.now(),deadline=loginStartedAt+5*60*1000;
    do{await new Promise(resolve=>setTimeout(resolve,1500));if(generation!==this.generation)throw new Error('Sign-in canceled.');connection=await this.status('openai');
     if(!connection.connected&&this.loginId){
      // The login-owning app-server keeps serving its pre-login snapshot; the OAuth callback's
      // auth.json write is the durable completion signal. Verify on a throwaway probe — the
      // listener is retired only when the probe actually reads the signed-in account. The
      // comparison is inclusive: a write in the same millisecond still postdates the login.
      let authMoved=0;try{authMoved=statSync(this.authFile()).mtimeMs;}catch{}
      if(authMoved>=loginStartedAt){
       const probe=this.spawnCodex();
       try{const probed=await this.openAiConnection(probe);if(probed.connected){this.codex?.stop();this.codex=probe;this.loginId=undefined;connection=probed;}}catch{}finally{if(this.codex!==probe)probe.stop();}
      }
     }
    }while(!connection.connected&&Date.now()<deadline);
    if(!connection.connected){
     // The app-server that owns the login can keep serving its pre-login account snapshot.
     // auth.json on disk is the durable record — a fresh process decides the verdict.
     this.codex?.stop();this.codex=undefined;this.loginId=undefined;
     connection=await this.status('openai');
    }
   }else{
    // Never null here: openai is the only browser-flow provider and it was handled above.
    const login=providerLogin(provider)!;
    // A visible official login terminal allows fallback code entry without exposing credentials to the renderer.
    await this.loginWindow(this.executable(login.provider),login.args,PROVIDER_TOOL_NAME[login.provider]);
    connection=await this.status(login.provider);
   }
  }
  if(generation!==this.generation)throw new Error('Sign-in canceled.');
  if(!connection.connected)throw new Error('Subscription sign-in could not be verified.');
  return connection;
 }
 /** A visible official login terminal allows fallback code entry without exposing credentials to the renderer. */
 private async loginWindow(executable:string,args:string[],toolName:string):Promise<void>{
  await new Promise<void>((resolve,reject)=>{const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
   const command=Buffer.from(`& '${executable.replaceAll("'","''")}' ${args.join(' ')}; exit $LASTEXITCODE`,'utf16le').toString('base64');
   const launcher=`$loginWindow = Start-Process -FilePath '${shell.replaceAll("'","''")}' -ArgumentList @('-NoProfile','-EncodedCommand','${command}') -PassThru -Wait; exit $loginWindow.ExitCode`;
   const child=spawn(shell,['-NoProfile','-Command',launcher],{cwd:this.root,env:subscriptionEnvironment(),windowsHide:true,stdio:'ignore'});this.loginProcess=child;
   const timeout=setTimeout(()=>{this.stopLogin();reject(new Error('Sign-in timed out. Try again.'));},5*60*1000);child.once('error',()=>{clearTimeout(timeout);reject(new Error(`Could not open the ${toolName} sign-in window.`));});child.once('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error(`${toolName} sign-in did not complete.`));});
  });
 }
 async confirm(id:string,save:(agent:Agent,observation:AccountObservation)=>void):Promise<void>{
  const ticket=this.ticket;if(!ticket||ticket.id!==id||ticket.expiresAt<Date.now())throw new Error('Connection confirmation expired. Click Add to verify again.');
  const generation=this.generation;const {connection:current,observation}=await this.observe(ticket.draft.provider);
  if(generation!==this.generation||this.ticket!==ticket)throw new Error('Confirmation canceled.');
  // A re-check that verifies sign-in but cannot name the account resolves through the same
  // still-fresh recorded identity the ticket may itself carry — the comparison is against the
  // account the office can name, not the empty string a transient fetch failure returned.
  const currentAccount=current.account||this.recordedIdentity(ticket.draft.provider,(ticket.draft.execution??'HOSTED_SETUP_REQUIRED')==='LOCAL');
  if(!current.connected||currentAccount!==ticket.connection.account)throw new Error('The signed-in account changed. Connect again before confirming.');
  if((ticket.draft.provider==='openai'||ticket.draft.provider==='devin')&&!current.models.some(m=>m.id===ticket.draft.model))throw new Error('Model access changed. Choose an available model.');
  this.validateEffort(ticket.draft.provider,ticket.draft.model,ticket.draft.effort??'default',current);
  // The caller commits the agent and this observation atomically; a failed durable write must create no agent.
  save({...ticket.draft,id:ticket.id,account:currentAccount,createdAt:new Date().toISOString(),connectionVerifiedAt:current.checkedAt,execution:ticket.draft.execution??'HOSTED_SETUP_REQUIRED'},observation);this.ticket=undefined;
 }
 /** One official check for an existing profile's provider, used by explicit Verify/Change connection. */
 async observeFor(provider:Provider):Promise<AccountObservation>{return (await this.observe(provider)).observation;}
 private stopLogin(){const child=this.loginProcess;if(child?.pid&&child.exitCode===null){const killer=path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe');execFile(killer,['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});}}
 cancel(){this.generation++;this.ticket=undefined;this.stopLogin();if(this.loginId&&this.codex)void this.codex.request('account/login/cancel',{loginId:this.loginId}).catch(()=>{});}
 close(){this.cancel();this.codex?.stop();}
}
