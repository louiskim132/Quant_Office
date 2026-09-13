import type {Effort,Provider} from './types.js';
export const efforts:Effort[]=['default','none','minimal','low','medium','high','xhigh','max','ultra'];
/** No inferred capability: aliases and missing catalogs remain unresolved. */
export function suggestedEfforts(_provider:Provider,_model:string):Effort[]{return ['default'];}
