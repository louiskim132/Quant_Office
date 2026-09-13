/** Bounded JSON parser for imported manifests. Duplicate keys must never be silently overwritten. */
export function parseStrictJson(text: string): unknown {
 let i=0, nodes=0;
 function space(){while(i<text.length&&/[\x20\x09\x0a\x0d]/.test(text[i]))i++;}
 function string():string {const start=i++;while(i<text.length){const c=text[i++];if(c==='"')return JSON.parse(text.slice(start,i)) as string;if(c==='\\'){if(i>=text.length)break;i++;}}throw new Error('Unterminated JSON string.');}
 function value(depth:number):unknown {
  if(depth>64||++nodes>100000)throw new Error('Manifest nesting or item limit exceeded.');space();const c=text[i];
  if(c==='"')return string();
  if(c==='{'){i++;space();const result:Record<string,unknown>=Object.create(null);const keys=new Set<string>();if(text[i]==='}'){i++;return result;}while(i<text.length){space();if(text[i]!=='"')throw new Error('Invalid JSON object key.');const key=string();if(keys.has(key))throw new Error('Duplicate JSON object key.');keys.add(key);space();if(text[i++]!==':')throw new Error('Invalid JSON object.');result[key]=value(depth+1);space();const separator=text[i++];if(separator==='}')return result;if(separator!==',')throw new Error('Invalid JSON object separator.');}throw new Error('Unterminated JSON object.');}
  if(c==='['){i++;space();const result:unknown[]=[];if(text[i]===']'){i++;return result;}while(i<text.length){result.push(value(depth+1));space();const separator=text[i++];if(separator===']')return result;if(separator!==',')throw new Error('Invalid JSON array separator.');}throw new Error('Unterminated JSON array.');}
  const token=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));if(!token)throw new Error('Invalid JSON value.');i+=token[0].length;return JSON.parse(token[0]);
 }
 const result=value(0);space();if(i!==text.length)throw new Error('Unexpected trailing JSON content.');return result;
}
