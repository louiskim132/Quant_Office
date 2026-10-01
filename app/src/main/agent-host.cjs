'use strict';
/*
 * QRO agent-isolation host (LR-16).
 *
 * Runs as the low-privilege QRO-Agent account, launched by the office through PowerShell
 * and a credential logon (ProcessStartInfo). Self-contained on purpose: node stdlib only, zero imports outside
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
 *   out-<id>.log / err-<id>.log          spawned child's stdout/stderr, pumped to append streams
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
const agentsRoot = path.basename(channelParent) === '.host' ? path.dirname(channelParent) : channelParent;
const sessionId = path.basename(sessionDir);
// Derived in the host account; office profile variables never cross the channel.
const hostUser = os.userInfo();
const hostProfile = hostUser.homedir;
if (process.platform === 'win32') {
  Object.assign(process.env, {
    USERPROFILE: hostProfile, HOME: hostProfile, USERNAME: hostUser.username,
    HOMEDRIVE: path.parse(hostProfile).root.replace(/[\\/]+$/, ''),
    HOMEPATH: hostProfile.slice(path.parse(hostProfile).root.length - 1),
    APPDATA: path.join(hostProfile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(hostProfile, 'AppData', 'Local'),
    TEMP: path.join(hostProfile, 'AppData', 'Local', 'Temp'),
    TMP: path.join(hostProfile, 'AppData', 'Local', 'Temp'),
    DISABLE_AUTOUPDATER: '1',
  });
  fs.mkdirSync(process.env.TEMP, { recursive: true });
}

/** The only env keys the office may push into an agent child — API keys and office flags. */
const ALLOWED_ENV = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|DEVIN_API_KEY|QRO_|NO_COLOR$|CI$)/;

const REQ = /^req-.+\.json$/;
const children = new Map(); // id → ChildProcess
const pendingInput = new Map();
const outStreams = new Map(); // id → {out, err} append-mode write streams, closed after exit
const pendingExits = new Map(); // id → {code, signal} waiting on the log streams to flush
const exitTimers = new Map(); // id → the bounded flush fallback
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

/** Stage markers in host-trace.log — a native abort leaves its last position behind on disk. */
function trace(text) {
  appendLog('host-trace.log', `${new Date().toISOString()} ${text}\n`);
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

function closeStreams(id) {
  const streams = outStreams.get(id);
  if (!streams) return;
  outStreams.delete(id);
  for (const stream of [streams.out, streams.err])
    try {
      stream.destroy();
    } catch {
      /* already closed */
    }
}

/**
 * exit-<id>.json lands only after both pumped logs have flushed — the office drains on sight of
 * the record, so tail bytes still in the pipe must not arrive after it. The bounded timer covers
 * a stream that never closes: a possibly-truncated tail beats no record at all.
 */
function flushExit(id, force = false) {
  const record = pendingExits.get(id);
  if (!record) return;
  const streams = outStreams.get(id);
  if (streams && !force)
    for (const stream of [streams.out, streams.err])
      if (!stream.destroyed && !stream.closed && !stream.writableFinished) return;
  pendingExits.delete(id);
  const timer = exitTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    exitTimers.delete(id);
  }
  closeStreams(id);
  writeJson(`exit-${id}.json`, record);
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
  const outPath = path.join(sessionDir, `out-${id}.log`);
  const errPath = path.join(sessionDir, `err-${id}.log`);
  // Writability probe BEFORE the child exists — the refusal stays synchronous and byte-identical.
  let probeFd;
  try {
    probeFd = fs.openSync(outPath, 'a');
    fs.closeSync(probeFd);
    probeFd = fs.openSync(errPath, 'a');
    fs.closeSync(probeFd);
    probeFd = undefined;
  } catch (error) {
    if (probeFd !== undefined)
      try {
        fs.closeSync(probeFd);
      } catch {
        /* already closed */
      }
    writeJson(`exit-${id}.json`, {
      code: null,
      signal: null,
      error: `refused: could not open log files (${error.message})`,
    });
    return;
  }
  // Crash-stage evidence: this line lands synchronously before the spawn, so a native host abort
  // leaves a marker showing the crash reached the spawn stage (vs. scan/watch lifecycle).
  appendLog(`err-${id}.log`, `agent-host: spawning ${req.exe}\n`);
  let child;
  try {
    // Piped stdio pumped into append-mode log streams — never raw fd stdio: handing open file fds
    // to uv_spawn from a console-less host aborts natively on Windows (0xC0000409 seen on CI).
    child = spawn(req.exe, req.argv.map(String), {
      cwd: path.resolve(req.cwd),
      // Only whitelisted office env crosses; everything else is this account's own environment.
      env: { ...process.env, ...sanitizeEnv(req.env) },
      stdio: [req.stdin === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    writeJson(`exit-${id}.json`, { code: null, signal: null, error: `spawn failed: ${error.message}` });
    return;
  }
  const outStream = fs.createWriteStream(outPath, { flags: 'a' });
  const errStream = fs.createWriteStream(errPath, { flags: 'a' });
  for (const [tag, stream] of [
    ['out', outStream],
    ['err', errStream],
  ]) {
    // An errored or closed log stream can be the last thing an exit record waits on.
    stream.on('error', error => {
      appendLog('host-errors.log', `agent-host: log stream ${tag}-${id}.log failed: ${error.message}\n`);
      flushExit(id, true);
    });
    stream.on('close', () => flushExit(id));
  }
  outStreams.set(id, { out: outStream, err: errStream });
  child.stdout.pipe(outStream);
  child.stderr.pipe(errStream);
  children.set(id, child);
  child.stdin?.on('error', () => {});
  for (const input of pendingInput.get(id) || []) onInput(input);
  pendingInput.delete(id);
  child.on('error', error => {
    children.delete(id);
    writeJson(`exit-${id}.json`, { code: null, signal: null, error: `spawn failed: ${error.message}` });
    closeStreams(id);
  });
  child.on('exit', (code, signal) => {
    if (!children.delete(id)) return; // an 'error' record already told the truth
    pendingExits.set(id, { code, signal });
    const timer = setTimeout(() => flushExit(id, true), 10_000);
    timer.unref();
    exitTimers.set(id, timer);
    flushExit(id);
  });
  child.on('close', () => flushExit(id));
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
  pendingInput.delete(id);
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
function onInput(req) {
  const id = String(req.id || '');
  if (!id || cancelled.has(id) || (typeof req.text === 'string' && Buffer.byteLength(req.text) > 1024 * 1024)) return;
  const child = children.get(id);
  if (!child) {
    const queue = pendingInput.get(id) || [];
    if (queue.length >= 128 || queue.reduce((sum, r) => sum + Buffer.byteLength(r.text || ''), 0) + Buffer.byteLength(req.text || '') > 1024 * 1024) return;
    queue.push(req);
    pendingInput.set(id, queue);
    return;
  }
  if (req.end === true) child.stdin?.end();
  else if (typeof req.text === 'string') child.stdin?.write(req.text);
}

function scan() {
  let names;
  try {
    names = fs
      .readdirSync(sessionDir)
      .filter(name => REQ.test(name))
      .sort();
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
      trace(`req ${name} op=${req && req.op}`);
      if (req && req.op === 'spawn') onSpawn(req);
      else if (req && req.op === 'stdin') onInput(req);
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
// No fs.watch: libuv's fs-event delivery (ReadDirectoryChangesW) natively aborts the host
// (0xC0000409) on Windows Server 2025-class builds — CI evidence — and a native abort cannot be
// caught. The 100 ms poll alone is the whole scan path; dispatch latency is irrelevant next to
// an agent run.
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
trace(`host up pid=${process.pid} user=${process.env.USERNAME || process.env.USER || 'unknown'}`);
writeJson(`ready-${sessionId}.json`, { pid: process.pid, user: hostUser.username, profile: hostProfile });
scan();
