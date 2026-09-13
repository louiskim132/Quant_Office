import { Subscriptions } from '../src/main/subscriptions.js';
import path from 'node:path';
const service=new Subscriptions(path.resolve('test-output/metadata-check'),async()=>{throw new Error('Read-only check must not open sign-in');});
try { const c=await service.status('openai');console.log(JSON.stringify({connected:c.connected,models:c.models.map(m=>m.id),windows:c.windows,note:c.note})); } finally {service.close();}

