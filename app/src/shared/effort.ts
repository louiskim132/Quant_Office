import type {Effort,Provider} from './types.js';
export const efforts:Effort[]=['default','none','minimal','low','medium','high','xhigh','max','ultra'];
/** No inferred capability: aliases and missing catalogs remain unresolved. */
export function suggestedEfforts(_provider:Provider,_model:string):Effort[]{return ['default'];}
/**
 * Curated model suggestions shown before (Claude) or alongside (OpenAI) a signed-in catalog.
 * Suggestions only — the model input is free-text and provider-side validation stays authoritative.
 * Claude entries are Claude Code aliases plus pinned IDs for the current generation; OpenAI entries
 * are Codex catalog names that the live `model/list` response replaces after sign-in.
 */
export const PROVIDER_MODEL_SUGGESTIONS:Record<Provider,{id:string;name:string}[]>={
 openai:[
  {id:'gpt-5.6-luna',name:'GPT-5.6 Luna'},
  {id:'gpt-5.6-terra',name:'GPT-5.6 Terra'},
  {id:'gpt-5.6-sol',name:'GPT-5.6 Sol'},
  {id:'gpt-5.5',name:'GPT-5.5'},
  {id:'gpt-5.3-codex',name:'GPT-5.3 Codex'},
  {id:'gpt-5.2-codex',name:'GPT-5.2 Codex'},
  {id:'gpt-5.1-codex',name:'GPT-5.1 Codex'},
  {id:'gpt-5-codex',name:'GPT-5 Codex'}
 ],
 claude:[
  {id:'best',name:'Best alias (latest Fable or Opus)'},
  {id:'fable',name:'Fable alias (Claude Fable 5)'},
  {id:'opus',name:'Opus alias (latest Opus)'},
  {id:'sonnet',name:'Sonnet alias (latest Sonnet)'},
  {id:'haiku',name:'Haiku alias (latest Haiku)'},
  {id:'opus[1m]',name:'Opus alias · 1M context'},
  {id:'sonnet[1m]',name:'Sonnet alias · 1M context'},
  {id:'opusplan',name:'Opus plan → Sonnet execution'},
  {id:'claude-fable-5-1',name:'Claude Fable 5.1 (pinned)'},
  {id:'claude-fable-5',name:'Claude Fable 5 (pinned)'},
  {id:'claude-opus-5',name:'Claude Opus 5 (pinned)'},
  {id:'claude-sonnet-5',name:'Claude Sonnet 5 (pinned)'},
  {id:'claude-haiku-4-5-20251001',name:'Claude Haiku 4.5 (pinned)'}
 ]
};
