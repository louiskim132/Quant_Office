import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AcpClient } from '../src/main/acp-client';
import { spawnTreeKillable } from '../src/main/local-cli-exec';
import { Subscriptions, subscriptionEnvironment } from '../src/main/subscriptions';
if (process.env.QRO_LIVE_ACP !== '1') throw new Error('Live subscription acceptance requires QRO_LIVE_ACP=1.');
const root = path.resolve(process.argv[2]);
mkdirSync(root, { recursive: true });
const subs = new Subscriptions(path.join(root, 'tools'), async () => {
  throw new Error('No browser');
});
const raw: string[] = [],
  stderr: string[] = [],
  sent: string[] = [];
const client = new AcpClient(
  (executable, args, options) => {
    const child = spawnTreeKillable(executable, args, options);
    child.stdout?.on('data', data => raw.push(String(data)));
    child.stderr?.on('data', data => stderr.push(String(data)));
    const write = child.stdin!.write.bind(child.stdin!);
    child.stdin!.write = ((data: any, ...args: any[]) => {
      sent.push(String(data));
      return (write as any)(data, ...args);
    }) as any;
    return child;
  },
  subs.toolPath('devin'),
  ['acp', '--model', 'swe-2-max'],
  { cwd: root, env: subscriptionEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  () => {},
);
let timer: ReturnType<typeof setTimeout> | undefined, hard: ReturnType<typeof setTimeout> | undefined;
try {
  const initialized = await client.initialize(),
    session = await client.create();
  timer = setTimeout(() => client.cancel(), 60_000);
  hard = setTimeout(() => client.stop(), 65_000);
  const result = await client.prompt(
    'Synthetic ACP transport check. Use your exec tool to write ack.txt containing ACP verified. Then reply OK. Do not read or write anything outside this directory, delegate or use networking.',
  );
  clearTimeout(timer);
  clearTimeout(hard);
  writeFileSync(
    path.join(root, 'report.json'),
    JSON.stringify(
      {
        initialized,
        session,
        result,
        output: existsSync(path.join(root, 'ack.txt')) ? readFileSync(path.join(root, 'ack.txt'), 'utf8') : null,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  clearTimeout(hard);
  client.stop();
  subs.close();
  writeFileSync(path.join(root, 'stdout.jsonl'), raw.join(''));
  writeFileSync(path.join(root, 'stdin.jsonl'), sent.join(''));
  writeFileSync(path.join(root, 'stderr.log'), stderr.join(''));
}
