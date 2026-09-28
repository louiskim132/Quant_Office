'use strict';
/*
 * QRO agent-isolation host (LR-16).
 *
 * Runs as the low-privilege QRO-Agent account, launched by the office through PowerShell
 * Start-Process -Credential. Self-contained on purpose: node stdlib only, zero imports outside
 * node:* — it executes outside the app's bundle.
 *
 *   argv[2] = sessionDir  — the per-office-run request channel directory
 *             (<agentsRoot>\.host\run-<id>). All req-*.json / out-*.log / err-*.log / exit-*.json
 *             files live here.
 *   argv[3] = officePid   — the office process to watch; the host exits when it is gone.
 *
 * agentsRoot is derived from the channel layout: the channel dir sits at <root>\.host\<run>, or
 * directly under the root for a hand-rolled channel. Everything the host may touch — request
 * files, log files, and every spawned cwd — stays inside that root.
 *
 * Requests ({op:'spawn'|'cancel'|'shutdown', id, ...}) arrive as req-<id>.json files written by
 * the office via <name>.tmp then rename — the host only ever acts on the final .json name, in
 * filename order. Replies are files written tmp-then-rename the same way so a reader never sees
 * a torn record:
 *   ready-<sessionId>.json {pid, user}   written once on startup (sessionId = basename(sessionDir))
 *   out-<id>.log / err-<id>.log          spawned child's stdout/stderr, append fds
 *   exit-<id>.json  {code, signal}       written when the child exits
 *                   {code:null, signal:null, error}  spawn refused or spawn failure — the child
 *                   never ran
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sessionDir = path.resolve(process.argv[2] || '');
const officePid = Number(process.argv[3]);
if (!sessionDir || !Number.isInteger(officePid) || officePid <= 0) {
  process.stderr.write('agent-host: sessionDir and officePid arguments are required\n');
  process.exit(2);
}
const channelParent = path.dirname(sessionDir);
const agentsRoot =
  path.basename(channelParent) === '.host' ? path.dirname(channelParent) : channelParent;
const sessionId = path.basename(sessionDir);

/** The only env keys the office may push into an agent child — API keys and office flags. */
const ALLOWED_ENV = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|DEVIN_API_KEY|QRO_|NO_COLOR$|CI$)/;

const REQ = /^req-.+\.json$/;
const children = new Map(); // id → ChildProcess
const outFds = new Map(); // id → {out, err} host-side fd copies, closed on exit
const seen = new Set(); // request filenames already acted on
const cancelled = new Set(); // ids the office cancelled — survives cancel-before-spawn ordering
let shuttingDown = false;

/** One request file's reply — written to a tmp name then renamed, like the office's own writes. */
function writeJson(name, value) {
  const target = path.join(sessionDir, name);
  const tmp = target + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    /* a channel the office stopped watching reports nothing — keep serving the rest */
  }
}

function appendLog(name, text) {
  try {
    fs.appendFileSync(path.join(sessionDir, name), text, 'utf8');
  } catch {
    /* the log is evidence, not control — a failed write must not crash the host */
  }
}

/** The packet-folder boundary: refuse anything whose cwd is not strictly inside agentsRoot. */
function insideAgentsRoot(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  let resolved;
  try {
    resolved = path.resolve(candidate);
  } catch {
    return false;
  }
  const relative = path.relative(agentsRoot, resolved);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function sanitizeEnv(env) {
  const out = {};
  if (env && typeof env === 'object')
    for (const [key, value] of Object.entries(env))
      if (ALLOWED_ENV.test(key) && typeof value === 'string') out[key] = value;
  return out;
}

function closeFds(id) {
  const fds = outFds.get(id);
  if (!fds) return;
  outFds.delete(id);
  for (const fd of [fds.out, fds.err])
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
}

function onSpawn(req) {
  const id = String(req.id || '');
  if (!id) return;
  // A cancel can be read before its spawn when both files land in one scan — either order must
  // converge on "never ran", so a cancelled id is refused rather than launched then killed.
  if (cancelled.has(id)) {
    writeJson(`exit-${id}.json`, { code: null, signal: 'SIGTERM' });
    return;
  }
  if (!insideAgentsRoot(req.cwd)) {
    appendLog(
      `err-${id}.log`,
      `agent-host: refused — cwd ${JSON.stringify(req.cwd)} is not inside the agent sessions root\n`,
    );
    writeJson(`exit-${id}.json`, {
      code: null,
      signal: null,
      error: `refused: cwd is outside the agent sessions root`,
    });
    return;
  }
  if (typeof req.exe !== 'string' || !req.exe || !Array.isArray(req.argv)) {
    writeJson(`exit-${id}.json`, { code: null, signal: null, error: 'refused: malformed spawn request' });
    return;
  }
  let outFd, errFd;
  try {
    outFd = fs.openSync(path.join(sessionDir, `out-${id}.log`), 'a');
    errFd = fs.openSync(path.join(sessionDir, `err-${id}.log`), 'a');
  } catch (error) {
    writeJson(`exit-${id}.json`, {
      code: null,
      signal: null,
      error: `refused: could not open log files (${error.message})`,
    });
    return;
  }
  outFds.set(id, { out: outFd, err: errFd });
  let child;
  try {
    child = spawn(req.exe, req.argv.map(String), {
      cwd: path.resolve(req.cwd),
      // Only whitelisted office env crosses; everything else is this account's own environment.
      env: { ...process.env, ...sanitizeEnv(req.env) },
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    });
  } catch (error) {
    closeFds(id);
    writeJson(`exit-${id}.json`, { code: null, signal: null, error: `spawn failed: ${error.message}` });
    return;
  }
  children.set(id, child);
  child.on('error', error => {
    writeJson(`exit-${id}.json`, { code: null, signal: null, error: `spawn failed: ${error.message}` });
    children.delete(id);
    closeFds(id);
  });
  child.on('exit', (code, signal) => {
    if (children.delete(id)) writeJson(`exit-${id}.json`, { code, signal });
    closeFds(id);
  });
}

function taskkillTree(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* a dead child needs no kill */
  }
}

function onCancel(req) {
  const id = String(req.id || '');
  if (!id) return;
  cancelled.add(id);
  const child = children.get(id);
  if (child && child.pid) taskkillTree(child.pid);
  // Already-exited ids need no kill — the exit record reports the truth.
}

function onShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) if (child && child.pid) taskkillTree(child.pid);
  // taskkill runs as its own process; exiting now does not wait for it, and the kills still land.
  setTimeout(() => process.exit(0), 50).unref();
}

/** One ordered pass over the channel: every new req-*.json, in filename order. */
function scan() {
  let names;
  try {
    names = fs.readdirSync(sessionDir).filter(name => REQ.test(name)).sort();
  } catch {
    return; // channel dir gone — the office-pid watchdog still applies
  }
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    let req;
    try {
      req = JSON.parse(fs.readFileSync(path.join(sessionDir, name), 'utf8'));
    } catch {
      appendLog('host-errors.log', `agent-host: unreadable request ${name}\n`);
      continue;
    }
    try {
      if (req && req.op === 'spawn') onSpawn(req);
      else if (req && req.op === 'cancel') onCancel(req);
      else if (req && req.op === 'shutdown') onShutdown();
    } catch (error) {
      appendLog('host-errors.log', `agent-host: request ${name} failed: ${error.message}\n`);
    }
    if (shuttingDown) return;
  }
}

try {
  fs.mkdirSync(sessionDir, { recursive: true });
} catch (error) {
  process.stderr.write(`agent-host: cannot create channel dir: ${error.message}\n`);
  process.exit(2);
}
try {
  fs.watch(sessionDir, () => scan());
} catch {
  /* the poll fallback below still delivers requests */
}
setInterval(scan, 100);
// The office owns the host's lifetime: when the office process is gone the host exits. EPERM means
// the pid exists but belongs to another account — alive, keep serving.
setInterval(() => {
  try {
    process.kill(officePid, 0);
  } catch (error) {
    if (error && error.code === 'EPERM') return;
    onShutdown();
  }
}, 5000);
writeJson(`ready-${sessionId}.json`, { pid: process.pid, user: os.userInfo().username });
scan();
