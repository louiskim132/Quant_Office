import packageInfo from '../../package.json' with {type:'json'};
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentDraftSchema, observationSchema } from '../core/store.js';
import { efforts } from '../shared/effort.js';
import type { Effort, Agent, AgentTicket, Connection, Provider, UsageWindow } from '../shared/types.js';
export type AccountObservation=z.infer<typeof observationSchema>;

export const providerSchema=z.enum(['openai','claude']);
const allowedMethods=new Set(['initialize','account/read','account/login/start','account/login/cancel','account/rateLimits/read','model/list']);
export function subscriptionEnvironment(): NodeJS.ProcessEnv {
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|CODEX_API_KEY)/i.test(key))delete env[key];
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
class CodexMetadata {
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
 constructor(private root:string,private openBrowser:(url:string)=>Promise<void>){
  mkdirSync(root,{recursive:true});
  try{this.paths=z.object({openai:z.string().optional(),claude:z.string().optional()}).strict().parse(JSON.parse(readFileSync(path.join(root,'provider-tools.json'),'utf8')));}catch{}
 }
 private executable(provider:Provider):string {
  const name=provider==='openai'?'codex.exe':'claude.exe';
  const selected=this.paths[provider];if(selected&&existsSync(selected))return selected;
  const candidates=(process.env.PATH||'').split(path.delimiter).filter(Boolean).map(p=>path.join(p,name));
  if(process.env.USERPROFILE)candidates.push(path.join(process.env.USERPROFILE,'.local','bin',name));
  if(provider==='openai'&&process.env.LOCALAPPDATA){
   const installed=path.join(process.env.LOCALAPPDATA,'OpenAI','Codex','bin');
   try{candidates.push(...readdirSync(installed,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>path.join(installed,d.name,name)).filter(p=>existsSync(p)).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs));}catch{}
  }
  const found=candidates.find(p=>existsSync(p));if(!found)throw new Error(`${provider==='openai'?'Codex':'Claude Code'} is not installed or could not be found. Install the official tool, then use Locate sign-in tool to select ${name}.`);return found;
 }
 select(provider:Provider,executable:string){
  if(!path.isAbsolute(executable)||path.basename(executable).toLowerCase()!==(provider==='openai'?'codex.exe':'claude.exe')||!existsSync(executable))throw new Error('Select the official provider executable.');
  this.cancel();this.codex?.stop();this.codex=undefined;this.versions.clear();this.paths[provider]=executable;writeFileSync(path.join(this.root,'provider-tools.json'),JSON.stringify(this.paths));
 }
 /** The official executable the office would run. Located here, never supplied by the renderer. */
 toolPath(provider:Provider):string{return this.executable(provider);}
 private client(){return this.codex??=new CodexMetadata(this.executable('openai'),this.root);}
 async status(provider:Provider):Promise<Connection>{
  const connection:Connection={provider,connected:false,account:'',models:[],windows:[],checkedAt:new Date().toISOString(),note:''};
  if(provider==='openai'){
   try{
    const client=this.client(),raw=await client.request('account/read',{refreshToken:true});
    if(raw.account?.type!=='chatgpt'){connection.note='Sign in with a ChatGPT subscription. API authentication is not accepted.';return connection;}
    connection.account=z.string().min(1).max(160).parse(raw.account.email);connection.connected=true;
    let cursor:string|null=null;const seen=new Set<string>();
    do{const result=await client.request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});for(const model of result.data??[])if(typeof model.id==='string'&&typeof model.displayName==='string')connection.models.push({id:model.id,name:model.displayName,efforts:['default',...(model.supportedReasoningEfforts??[]).map((e:any)=>e.reasoningEffort).filter((e:any)=>efforts.includes(e)&&e!=='default')],defaultEffort:efforts.includes(model.defaultReasoningEffort)?model.defaultReasoningEffort:undefined,effortDescriptions:(model.supportedReasoningEfforts??[]).filter((e:any)=>efforts.includes(e.reasoningEffort)&&typeof e.description==='string').map((e:any)=>({effort:e.reasoningEffort,description:e.description})),source:'Installed Codex app-server model/list; cloud application unverified'});cursor=result.nextCursor??null;if(cursor&&seen.has(cursor))throw new Error('Repeated model catalog page');if(cursor)seen.add(cursor);}while(cursor);
    try{connection.windows=usageWindows(await client.request('account/rateLimits/read'));}catch{connection.note='Usage unavailable from Codex. Refresh to retry.';}
    if(!connection.windows.length&&!connection.note)connection.note='Usage unavailable from Codex for this account.';
   }catch(error){this.codex?.stop();this.codex=undefined;throw error;}
  }else{
   const raw=await new Promise<string>((resolve,reject)=>execFile(this.executable('claude'),['auth','status'],{cwd:this.root,env:subscriptionEnvironment(),windowsHide:true,timeout:30000,maxBuffer:1024*1024},(error,stdout)=>{if(error&&!stdout){reject(new Error('Claude Code status unavailable. Update the official tool and retry.'));return;}resolve(stdout);}));
   try{connection.account=claudeIdentity(JSON.parse(raw));connection.connected=true;}catch{connection.note='Sign in through Claude Code with a Claude subscription.';return connection;}
   connection.models=[{id:'opus',name:'Opus (Claude Code alias)'},{id:'sonnet',name:'Sonnet (Claude Code alias)'},{id:'haiku',name:'Haiku (Claude Code alias)'}];
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
  const accountSource=provider==='openai'?'codex app-server account/read':'claude auth status';
  const operations:AccountObservation['operations']=[
   observed('ACCOUNT_STATUS',connection.connected?'ACCOUNT_VERIFIED':'UNAVAILABLE',connection.connected?'Official tool reported a signed-in subscription for this account.':connection.note||'No signed-in subscription reported.',accountSource),
   provider==='openai'
    ?observed('MODEL_CATALOG',connection.models.length?'ACCOUNT_VERIFIED':'UNAVAILABLE',connection.models.length?`Catalog of ${connection.models.length} models returned by the official app-server for this account.`:'No catalog returned for this account.','codex app-server model/list')
    :documented('MODEL_CATALOG','TOOL_SUPPORTED','Claude Code model aliases are built into this application. They were not read from the tool and are not an entitlement check for this account.','application alias list'),
   provider==='openai'
    ?observed('ALLOWANCE_READ',connection.windows.length?'ACCOUNT_VERIFIED':'UNAVAILABLE',connection.windows.length?`${connection.windows.length} rate-limit windows read for this account.`:connection.note||'Usage unavailable for this account.','codex app-server account/rateLimits/read')
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
  return {connection,observation:{
   provider,identity:connection.account,credentialContext:provider==='openai'?'codex-cli':'claude-code-cli',
   state:connection.connected?'SIGNED_IN':'SIGNED_OUT',allowance:connection.windows,note:connection.note,
   toolVersion,transport:'NONE',environment:'',
   models:connection.models.map(model=>({id:model.id,name:model.name,...(model.efforts?{efforts:model.efforts}:{}),...(model.defaultEffort?{defaultEffort:model.defaultEffort}:{}),...(model.effortDescriptions?.length?{effortDescriptions:model.effortDescriptions}:{}),...(model.source?{source:model.source}:{})})),
   operations,source:accountSource,
   observedAt:at,
  }};
 }
 validateEffort(provider:Provider,model:string,effort:Effort,connection?:Connection):void {
  if(effort==='default')return;
  const supported=connection?.provider===provider?connection.models.find(m=>m.id===model)?.efforts??['default']:['default'];
  if(!supported.includes(effort))throw new Error('This effort level is not supported by the selected model. Refresh model options or choose Default.');
 }
 async connect(input:unknown):Promise<AgentTicket>{
  if(this.connecting)throw new Error('Another sign-in is already in progress. Cancel it first.');
  const draft=agentDraftSchema.parse(input);this.connecting=true;this.ticket=undefined;const generation=++this.generation;
  try{
   let connection=await this.status(draft.provider);
   if(!connection.connected){
    if(draft.provider==='openai'){
     const result=await this.client().request('account/login/start',{type:'chatgpt'});this.loginId=result.loginId;
     const url=new URL(result.authUrl);if(url.protocol!=='https:'||!['auth.openai.com','chatgpt.com','auth.chatgpt.com'].includes(url.hostname))throw new Error('Unexpected provider sign-in URL.');
     await this.openBrowser(url.href);
     const deadline=Date.now()+5*60*1000;
     do{await new Promise(resolve=>setTimeout(resolve,1500));if(generation!==this.generation)throw new Error('Sign-in canceled.');connection=await this.status('openai');}while(!connection.connected&&Date.now()<deadline);
    }else{
     const executable=this.executable('claude');
     // A visible official login terminal allows fallback code entry without exposing credentials to the renderer.
     await new Promise<void>((resolve,reject)=>{const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const command=Buffer.from(`& '${executable.replaceAll("'","''")}' auth login; exit $LASTEXITCODE`,'utf16le').toString('base64');
      const launcher=`$loginWindow = Start-Process -FilePath '${shell.replaceAll("'","''")}' -ArgumentList @('-NoProfile','-EncodedCommand','${command}') -PassThru -Wait; exit $loginWindow.ExitCode`;
      const child=spawn(shell,['-NoProfile','-Command',launcher],{cwd:this.root,env:subscriptionEnvironment(),windowsHide:true,stdio:'ignore'});this.loginProcess=child;
      const timeout=setTimeout(()=>{this.stopLogin();reject(new Error('Sign-in timed out. Try again.'));},5*60*1000);child.once('error',()=>{clearTimeout(timeout);reject(new Error('Could not open the Claude Code sign-in window.'));});child.once('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error('Claude Code sign-in did not complete.'));});
     });connection=await this.status('claude');
    }
   }
   if(generation!==this.generation)throw new Error('Sign-in canceled.');
   if(!connection.connected)throw new Error('Subscription sign-in could not be verified.');
   if(draft.provider==='openai'&&!connection.models.some(m=>m.id===draft.model))throw new Error('The selected model is not in your available Codex catalog. Refresh models and select again.');
   this.validateEffort(draft.provider,draft.model,draft.effort??'default',connection);
   this.ticket={id:randomUUID(),draft,connection,expiresAt:Date.now()+10*60*1000};return structuredClone(this.ticket);
  }finally{this.connecting=false;this.loginProcess=undefined;this.loginId=undefined;}
 }
 async confirm(id:string,save:(agent:Agent,observation:AccountObservation)=>void):Promise<void>{
  const ticket=this.ticket;if(!ticket||ticket.id!==id||ticket.expiresAt<Date.now())throw new Error('Connection confirmation expired. Click Add to verify again.');
  const generation=this.generation;const {connection:current,observation}=await this.observe(ticket.draft.provider);
  if(generation!==this.generation||this.ticket!==ticket)throw new Error('Confirmation canceled.');
  if(!current.connected||current.account!==ticket.connection.account)throw new Error('The signed-in account changed. Connect again before confirming.');
  if(ticket.draft.provider==='openai'&&!current.models.some(m=>m.id===ticket.draft.model))throw new Error('Model access changed. Choose an available model.');
  this.validateEffort(ticket.draft.provider,ticket.draft.model,ticket.draft.effort??'default',current);
  // The caller commits the agent and this observation atomically; a failed durable write must create no agent.
  save({...ticket.draft,id:ticket.id,account:current.account,createdAt:new Date().toISOString(),connectionVerifiedAt:current.checkedAt,execution:'HOSTED_SETUP_REQUIRED'},observation);this.ticket=undefined;
 }
 /** One official check for an existing profile's provider, used by explicit Verify/Change connection. */
 async observeFor(provider:Provider):Promise<AccountObservation>{return (await this.observe(provider)).observation;}
 private stopLogin(){const child=this.loginProcess;if(child?.pid&&child.exitCode===null){const killer=path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe');execFile(killer,['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});}}
 cancel(){this.generation++;this.ticket=undefined;this.stopLogin();if(this.loginId&&this.codex)void this.codex.request('account/login/cancel',{loginId:this.loginId}).catch(()=>{});}
 close(){this.cancel();this.codex?.stop();}
}
