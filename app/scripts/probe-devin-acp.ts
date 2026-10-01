/** Initialization only: no session/new, prompt, model inference, login or cloud task. */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Subscriptions, subscriptionEnvironment } from '../src/main/subscriptions';
const subs = new Subscriptions('test-output/acp-tools', async () => {
  throw new Error('No browser/login');
});
const child = spawn(await subs.toolPath('devin'), ['acp', '--model', 'swe-2-max'], {
  env: subscriptionEnvironment(),
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const lines: string[] = [];
let pending = '';
const reply = await new Promise<unknown>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('ACP initialize timeout')), 15_000);
  child.stdout.on('data', chunk => {
    pending += String(chunk);
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'),
        line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      lines.push(line);
      try {
        const frame = JSON.parse(line);
        if (frame.id === 1) {
          clearTimeout(timer);
          resolve(frame);
        }
      } catch {
        /* raw output retained */
      }
    }
  });
  child.once('error', e => {
    clearTimeout(timer);
    reject(e);
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'qro-readonly-probe', version: '1.0.0' },
      },
    }) + '\n',
  );
}).finally(() => {
  child.stdin.end();
  child.kill();
  subs.close();
});
const report = {
  scope: 'INITIALIZATION_ONLY',
  sessionCreated: false,
  promptSent: false,
  modelInference: false,
  response: reply,
  lines,
};
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
