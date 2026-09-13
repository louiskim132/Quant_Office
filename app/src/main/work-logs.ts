import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {WorkLog} from '../shared/types.js';
import {parseStrictJson} from '../core/strict-json.js';
const endpoint=z.union([z.string().uuid(),z.enum(['USER','TOOL','SYSTEM'])]);
const rowSchema=z.object({format:z.literal('qro-log-v1'),conversationId:z.string().min(1).max(200),messageId:z.string().min(1).max(200),from:endpoint,to:endpoint,kind:z.enum(['MESSAGE','TOOL','STATUS']),text:z.string().max(64000),timestamp:z.string().datetime({offset:true})}).strict();
function stableId(value:string){const h=createHash('sha256').update(value).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
function visibleText(content:unknown):string{
 if(typeof content==='string')return content;
 if(!Array.isArray(content))return '';
 return content.filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\n');
}
/** Explicit user import only. No transcript text is read by the consumption scanner or sent to providers. */
export function parseWorkLogs(bytes:Buffer,agentId:string,knownAgents:Set<string>):{entries:WorkLog[];skipped:number}{
 if(bytes.length>16*1024*1024)throw new Error('Import a log no larger than 16 MiB.');
 if(!knownAgents.has(agentId))throw new Error('Agent not found.');
 const sourceHash=createHash('sha256').update(bytes).digest('hex');let skipped=0;const entries:WorkLog[]=[];
 const lines=bytes.toString('utf8').split(/\r?\n/);if(lines.length>20000)throw new Error('Log exceeds 20,000 lines.');
 for(const [lineIndex,line] of lines.entries()){
  if(!line.trim())continue;if(line.length>2*1024*1024)throw new Error(`Log line ${lineIndex+1} exceeds the size limit.`);
  let raw:any;try{raw=parseStrictJson(line);}catch{throw new Error(`Invalid JSON on log line ${lineIndex+1}. No entries imported.`);}
  let row:z.infer<typeof rowSchema>;
  if(raw?.format==='qro-log-v1')row=rowSchema.parse(raw);
  else if((raw?.type==='assistant'||raw?.type==='user')&&typeof raw.sessionId==='string'&&typeof raw.timestamp==='string'){
   const content=raw.message?.content;const text=visibleText(content);
   const toolNames=Array.isArray(content)?content.filter(x=>x?.type==='tool_use'&&typeof x.name==='string').map(x=>x.name):[];
   const tools=Array.isArray(content)?content.filter(x=>x?.type==='tool_result').map(x=>visibleText(x.content)):[];
   if(!text&&!toolNames.length&&!tools.some(Boolean)){skipped++;continue;}
   const isTool=toolNames.length>0||tools.length>0;
   const value=[text,...toolNames.map(name=>`Tool requested: ${name}`),...tools.map(t=>`Tool result: ${t}`)].filter(Boolean).join('\n');
   row=rowSchema.parse({format:'qro-log-v1',conversationId:`claude:${raw.sessionId}`,messageId:raw.uuid||raw.message?.id||`line-${lineIndex+1}`,from:raw.type==='assistant'?agentId:tools.length?'TOOL':'USER',to:raw.type==='assistant'?toolNames.length?'TOOL':'USER':agentId,kind:isTool?'TOOL':'MESSAGE',text:value,timestamp:raw.timestamp});
  }else{skipped++;continue;}
  for(const who of [row.from,row.to])if(!['USER','SYSTEM','TOOL'].includes(who)&&!knownAgents.has(who))throw new Error(`Log line ${lineIndex+1} refers to an unknown agent.`);
  if(row.from!==agentId&&row.to!==agentId)throw new Error(`Log line ${lineIndex+1} does not involve the selected agent.`);
  entries.push({id:stableId(JSON.stringify([row.conversationId,row.messageId,row.from,row.to,row.kind])),conversationId:row.conversationId,externalId:row.messageId,from:row.from,to:row.to,kind:row.kind,text:row.text,timestamp:new Date(row.timestamp).toISOString(),sourceHash,provenance:'USER_IMPORTED'});
 }
 if(!entries.length)throw new Error('No supported visible messages or work events found in this file.');
 return {entries,skipped};
}
