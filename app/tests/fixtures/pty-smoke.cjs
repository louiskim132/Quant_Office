// Proves the installed node-pty drives a real terminal on this machine.
// It runs as a separate process because node-pty keeps a ConPTY handle alive after the child exits,
// which would otherwise stop the test runner from exiting.
const nodePty = require('node-pty');
const terminal = nodePty.spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'echo pty-smoke-ok'], {
  name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
});
let output = '';
terminal.onData(chunk => { output += chunk; });
terminal.onExit(({ exitCode }) => {
  process.stdout.write(JSON.stringify({ exitCode, sawOutput: output.includes('pty-smoke-ok'), node: process.versions.node }) + '\n');
  process.exit(0);
});
setTimeout(() => { process.stdout.write(JSON.stringify({ timedOut: true, output }) + '\n'); process.exit(2); }, 20000);
