import type { ToolProfile } from '../shared/tool-profile.js';
import type { LocalSessionRecord } from '../shared/local-session.js';
import type { CliChild } from './local-cli-exec.js';

/**
 * The Serena build this binding was written against — PyPI `serena-agent` 1.7.0,
 * installed per docs/plugin-surfaces.md via `uv tool install -p 3.13 serena-agent`
 * (or run transiently as `uvx --from serena-agent==1.7.0 serena`). The launch
 * command itself comes from the tool profile's mcpServers entry; this constant
 * names the version the binding expects so a drifted install surfaces in reason
 * strings rather than passing silently.
 */
export const SERENA_EXPECTED_VERSION = '1.7.0';

/**
 * The argv marker appended when a binding's serena entry declares readOnly.
 * Honest caveat: upstream `serena start-mcp-server` documents no such flag on
 * the pinned build (v1.7.0, verified against src/serena/cli.py on 2026-09-22) —
 * the documented read-only mechanism is `read_only: true` in the packet's
 * `.serena/project.yml`. The flag is emitted verbatim anyway so the spawned argv
 * carries the declared posture, and the emission is fail-closed: a build that
 * rejects the flag exits before answering the handshake, readiness resolves
 * ok:false, and a read-only binding can never come up quietly writable.
 * Organizer follow-up: if no released build accepts the flag, write
 * `read_only: true` into `.serena/project.yml` before spawn instead.
 */
export const SERENA_READ_ONLY_ARG = '--read-only';

/** MCP stdio is newline-delimited JSON-RPC; one initialize request probes readiness. */
const MCP_PROTOCOL_VERSION = '2024-11-05';
const INITIALIZE_ID = 1;
/** An MCP server that cannot answer initialize within this window is not ready. */
const READY_TIMEOUT_MS = 30_000;
/** A stdout that never emits a newline-terminated message is broken, not verbose. */
const MAX_PENDING_BYTES = 256 * 1024;

/**
 * The child surface a serena stdio session needs — the adapter's CliChild plus a
 * writable stdin. CliSpawnOptions pins stdin to 'ignore' because CLI exec sessions
 * never write to the child; this module must, to drive the MCP handshake.
 */
/** Splits a declared server command into its executable and any leading sub-command words. */
export function splitCommand(command: string): string[] {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts : [command];
}

/** Whether a probe failure means the declared executable is not installed at all. */
export const serenaNotInstalled = (reason: string) => /\bENOENT\b/.test(reason);

export interface SerenaChild extends CliChild {
  readonly stdin: NodeJS.WritableStream | null;
}
export interface SerenaSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  stdio: ['pipe', 'pipe', 'pipe'];
}
export type SerenaSpawn = (executable: string, args: string[], options: SerenaSpawnOptions) => SerenaChild;

export interface SerenaSessionRequest {
  /** The local-session binding this tool server serves — the jobId labels readiness reasons. */
  binding: Pick<LocalSessionRecord, 'jobId'>;
  /** The declared tool scope; the entry whose id is 'serena' supplies command and args. */
  profile: ToolProfile;
  /** The session's packet directory — passed to serena as `--project`. */
  packetDir: string;
}

export interface SerenaSessionDeps {
  spawn: SerenaSpawn;
  /** Wall clock in ms — stamps elapsed time in reason strings. Defaults to Date.now. */
  clock?: () => number;
  /** Handshake deadline override (tests); defaults to READY_TIMEOUT_MS. */
  readyTimeoutMs?: number;
}

export interface SerenaSession {
  /** Resolves exactly once — ok:true only after an observed handshake response. */
  readonly ready: Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Kills the child once; repeated calls are safe no-ops. */
  dispose(): void;
}

/**
 * Spawns one office-owned Serena MCP server bound to a session's packet directory.
 *
 * Serena is stateful — exactly one active project per process — so each session gets
 * its own stdio server pointed at its own packet dir. This module owns only the
 * spawn and the readiness handshake: it is not an MCP client, and readiness here
 * means "the server answered initialize over stdio", not "a project-scoped tool
 * call succeeded" (docs/plugin-surfaces.md's fuller readiness is the caller's).
 *
 * Nothing here throws past the caller: a missing profile entry, a spawn that
 * throws, a dead child or a timeout all resolve `ready` as {ok:false, reason}.
 */
export function spawnSerenaSession(request: SerenaSessionRequest, deps: SerenaSessionDeps): SerenaSession {
  const now = deps.clock ?? Date.now;
  const startedAt = now();
  const elapsed = () => Math.max(0, Math.round(now() - startedAt));

  const entry = request.profile.mcpServers?.find(server => server.id === 'serena');
  let settled = false;
  let disposed = false;
  let child: SerenaChild | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Buffered stdout bytes not yet terminated by a newline. */
  let pending = '';
  /** The child's last stderr line — context for failure reasons, not evidence. */
  let stderrTail = '';

  let resolveReady: (outcome: { ok: true } | { ok: false; reason: string }) => void;
  const ready = new Promise<{ ok: true } | { ok: false; reason: string }>(resolve => { resolveReady = resolve; });

  const settle = (outcome: { ok: true } | { ok: false; reason: string }) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    resolveReady(outcome);
  };
  const fail = (reason: string) => settle({ ok: false, reason: stderrTail ? `${reason} (stderr: ${stderrTail})` : reason });

  if (!entry) {
    settle({ ok: false, reason: `the tool profile declares no 'serena' mcpServers entry; nothing was spawned for job ${request.binding.jobId}` });
    return { ready, dispose() { /* nothing was ever spawned */ } };
  }

  const args = [
    ...(entry.args ?? []),
    '--project', request.packetDir,
    ...(entry.readOnly ? [SERENA_READ_ONLY_ARG] : []),
  ];

  // A declared command may carry its sub-command ("serena start-mcp-server"); spawn runs without a
  // shell, so the executable and its leading arguments are separated here.
  const [executable, ...leading] = splitCommand(entry.command);
  try {
    child = deps.spawn(executable, [...leading, ...args], {
      cwd: request.packetDir, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    settle({ ok: false, reason: `serena spawn threw before a child existed: ${error instanceof Error ? error.message : String(error)}` });
    return { ready, dispose() { /* spawn threw; nothing to kill */ } };
  }

  if (!child.stdin) {
    settle({ ok: false, reason: 'the spawned serena child has no writable stdin; the initialize handshake cannot be sent' });
    return { ready, dispose: makeDispose() };
  }

  const writeHandshake = () => {
    try {
      child!.stdin!.write(`${JSON.stringify({
        jsonrpc: '2.0', id: INITIALIZE_ID, method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'quant-office-serena-binding', version: SERENA_EXPECTED_VERSION } },
      })}\n`);
      return true;
    } catch (error) {
      fail(`could not write the initialize request to serena's stdin: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const onStdout = (chunk: unknown) => {
    if (settled) return;
    pending += String(chunk);
    if (pending.length > MAX_PENDING_BYTES) {
      fail(`serena emitted ${pending.length} stdout bytes without a handshake response; treating the stream as malformed`);
      return;
    }
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      if (!line) continue;
      let message: { id?: unknown; result?: unknown; error?: { message?: string } | unknown };
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== INITIALIZE_ID) continue;
      if ('result' in message) {
        // Proper MCP etiquette — the client acknowledges the negotiated session.
        try { child!.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); } catch { /* readiness already established */ }
        settle({ ok: true });
      } else if (message.error) {
        const detail = message.error && typeof message.error === 'object'
          ? String((message.error as { message?: unknown }).message ?? JSON.stringify(message.error))
          : JSON.stringify(message.error);
        fail(`serena answered initialize with a JSON-RPC error: ${detail}`);
      }
    }
  };

  function makeDispose() {
    return () => {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!settled) settle({ ok: false, reason: 'the session was disposed before the handshake completed' });
      try { child?.kill(); } catch { /* a dead child reports nothing */ }
    };
  }

  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', chunk => {
    const text = String(chunk).trim();
    if (text) stderrTail = text.split(/\r?\n/).pop()!.slice(0, 200);
  });
  child.on('error', error => fail(`the spawned serena process reported an error: ${error.message}`));
  child.on('exit', (code, signal) => {
    if (disposed) { settle({ ok: false, reason: `serena exited after dispose (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})` }); return; }
    fail(`serena exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}) before answering the initialize handshake after ${elapsed()}ms`);
  });

  if (!writeHandshake()) return { ready, dispose: makeDispose() };

  const timeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  timer = setTimeout(() => {
    timer = undefined;
    fail(`no handshake response from serena within ${timeoutMs}ms; killing the unresponsive child`);
    try { child?.kill(); } catch { /* the failure reason already stands */ }
  }, timeoutMs);
  // A readiness deadline is bookkeeping, not work — it must never hold the process open.
  timer.unref?.();

  return { ready, dispose: makeDispose() };
}
