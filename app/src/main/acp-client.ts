import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { GuardedLocalFileIO } from './local-session-files.js';
import path from 'node:path';
import type { CliChild, CliSpawn, CliSpawnOptions } from './local-cli-exec.js';
import { EVIDENCE_SURFACE_ID, type ToolProfile } from '../shared/tool-profile.js';

export const ACP_STATE_FILE = 'office-acp-session.json';
const MAX_FRAME = 1024 * 1024;
export class AcpProviderError extends Error {}

/** Select only a single-use permission for declared tool kinds and reported packet locations. */
export function acpPermission(params: any, cwd: string, profile?: ToolProfile): { outcome: any } {
  const call = params?.toolCall;
  const kind = call?.kind;
  const names: Record<string, string[]> = {
    read: ['Read', 'read'],
    search: ['Glob', 'Grep', 'grep', 'find_file_by_name'],
    edit: ['Write', 'Edit', 'edit', 'write'],
    execute: ['Bash', 'Shell', 'exec'],
  };
  let allowed = !!names[kind];
  if (profile?.canWrite === false && ['edit', 'execute'].includes(kind)) allowed = false;
  if (profile?.allowedTools?.length && !names[kind]?.some(name => profile.allowedTools!.includes(name)))
    allowed = false;
  if (call?.locations !== undefined && !Array.isArray(call.locations)) allowed = false;
  for (const location of Array.isArray(call?.locations) ? call.locations : []) {
    const relative = typeof location?.path === 'string' ? path.relative(cwd, path.resolve(cwd, location.path)) : '..';
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) allowed = false;
  }
  const option =
    allowed &&
    Array.isArray(params?.options) &&
    params.options.find((o: any) => o?.kind === 'allow_once' && typeof o.optionId === 'string');
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/** JSONL ACP v1. Session updates are streamed; only actual RPC replies resolve requests. */
export class AcpClient {
  readonly child: CliChild;
  private sequence = 0;
  private buffer = '';
  private closed = false;
  private cancelled = false;
  private sessionId?: string;
  private toolCalls = new Map<string, Record<string, unknown>>();
  private pending = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(
    spawn: CliSpawn,
    executable: string,
    args: string[],
    private options: CliSpawnOptions,
    private update: (frame: unknown) => void,
    private readonly profile?: ToolProfile,
  ) {
    this.child = spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!this.child.stdin) throw new Error('ACP requires writable stdin.');
    this.child.stdin.on('error', () => this.close(new Error('ACP input stream closed.')));
    this.child.on('error', error => this.close(error));
    this.child.on('exit', () => this.close(new Error('ACP process exited.')));
    this.child.stdout?.on('data', chunk => {
      this.buffer += String(chunk);
      if (Buffer.byteLength(this.buffer) > MAX_FRAME) {
        this.child.kill();
        this.close(new Error('ACP frame exceeds its bound.'));
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        let frame: any;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (!frame || frame.jsonrpc !== '2.0') continue;
        if (frame.method && frame.id !== undefined) {
          if (frame.method === 'session/request_permission' && frame.params?.sessionId === this.sessionId) {
            const call = frame.params.toolCall;
            // Permission requests may carry only an update; kind/locations come from the matching
            // session's earlier tool_call. Unknown identities or kinds remain refused.
            const known = typeof call?.toolCallId === 'string' ? this.toolCalls.get(call.toolCallId) : undefined;
            const result = this.cancelled
              ? { outcome: { outcome: 'cancelled' } }
              : acpPermission({ ...frame.params, toolCall: { ...known, ...call } }, options.cwd, profile);
            this.send({ jsonrpc: '2.0', id: frame.id, result });
          } else
            this.send({
              jsonrpc: '2.0',
              id: frame.id,
              error: { code: -32601, message: 'Client capability is not available.' },
            });
        } else if (frame.method === 'session/update' && frame.params?.sessionId === this.sessionId) {
          const update = frame.params.update;
          if (
            ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) &&
            typeof update.toolCallId === 'string'
          ) {
            this.toolCalls.set(update.toolCallId, { ...this.toolCalls.get(update.toolCallId), ...update });
            if (this.toolCalls.size > 200) this.toolCalls.delete(this.toolCalls.keys().next().value!);
          }
          this.update(frame);
        } else if (typeof frame.id === 'number') {
          const item = this.pending.get(frame.id);
          if (!item) continue;
          clearTimeout(item.timer);
          this.pending.delete(frame.id);
          if (frame.error)
            item.reject(
              new AcpProviderError(
                `ACP provider response: ${String(frame.error.message || 'request failed').slice(0, 1500)}`,
              ),
            );
          else item.resolve(frame.result);
        }
      }
    });
  }
  private send(frame: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin!.write(JSON.stringify(frame) + '\n');
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private sessionParams() {
    return {
      cwd: this.options.cwd,
      mcpServers: (this.profile?.mcpServers ?? [])
        .filter(server => server.id !== EVIDENCE_SURFACE_ID)
        .map(server => ({ name: server.id, command: server.command, args: server.args ?? [], env: [] })),
    };
  }
  request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('ACP is closed.'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async initialize(): Promise<any> {
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'quant-research-office', version: '0.5.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (result?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version.');
    return result;
  }
  async create(): Promise<any> {
    const result = await this.request('session/new', this.sessionParams());
    if (typeof result?.sessionId !== 'string' || !result.sessionId || result.sessionId.length > 200)
      throw new Error('ACP returned no valid session identity.');
    this.sessionId = result.sessionId;
    return result;
  }
  async load(sessionId: string): Promise<any> {
    this.sessionId = sessionId;
    return this.request('session/load', { sessionId, ...this.sessionParams() });
  }
  prompt(text: string): Promise<any> {
    if (!this.sessionId) return Promise.reject(new Error('ACP has no bound session.'));
    return this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, 30 * 60_000);
  }
  cancel(): void {
    this.cancelled = true;
    if (this.sessionId && !this.closed)
      this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
  }
  close(error = new Error('ACP client closed.')): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
  stop(): void {
    this.close();
    this.child.kill();
  }
}

/** Bridge ACP to the existing packet/receipt lifecycle. A finished turn never fabricates result.json. */
export class AcpPacketChild extends EventEmitter implements CliChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly client: AcpClient;
  get pid(): number | undefined {
    return this.client.child.pid;
  }
  private record: Record<string, unknown> = { schemaVersion: 1, state: 'INITIALIZING', provenance: 'OFFICE_LOCAL' };
  private completed = false;
  private cancelled = false;
  private turnFinished: Promise<void>;
  stopReason?: string;
  sessionId?: string;
  providerError?: string;
  get exited(): boolean {
    return this.completed;
  }
  constructor(spawn: CliSpawn, executable: string, args: string[], options: CliSpawnOptions) {
    super();
    const payload = JSON.parse(args.at(-1)!);
    const providerArgs = args.slice(0, -1);
    const file = path.join(options.cwd, ACP_STATE_FILE);
    const persist = () => {
      const io = new GuardedLocalFileIO();
      const temporary = ACP_STATE_FILE + '.' + randomUUID() + '.tmp';
      io.writeNew(options.cwd, temporary, Buffer.from(JSON.stringify(this.record, null, 2)));
      io.inspectRoot(options.cwd);
      renameSync(path.join(options.cwd, temporary), file);
    };
    const client = (this.client = new AcpClient(
      spawn,
      executable,
      providerArgs,
      options,
      frame => this.stdout.write(JSON.stringify(frame) + '\n'),
      payload.profile,
    ));
    this.client.child.stderr?.on('data', chunk => this.stderr.write(chunk));
    this.client.child.on('error', error => this.emit('error', error));
    this.client.child.on('exit', (code, signal) => {
      this.completed = true;
      this.stdout.end();
      this.stderr.end();
      this.emit('exit', code, signal);
    });
    this.turnFinished = (async () => {
      try {
        // Existing identity is never re-prompted automatically after a crash/retry.
        if (existsSync(file))
          throw new Error('An ACP identity already exists; reconcile it instead of starting another session.');
        persist();
        const capabilities = await client.initialize();
        if (this.cancelled) return;
        const session = await client.create();
        const selected =
          session.configOptions?.find((option: any) => option.id === 'model')?.currentValue ??
          session.models?.currentModelId;
        if (selected && selected !== providerArgs.at(-1))
          throw new AcpProviderError('ACP selected a different model than the frozen request.');
        this.sessionId = session.sessionId;
        this.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', method: 'office/acp-session', params: { sessionId: session.sessionId } }) +
            '\n',
        );
        this.record = {
          ...this.record,
          state: 'RUNNING',
          sessionId: session.sessionId,
          requestedModel: providerArgs.at(-1),
          providerSelectedModel: selected ?? null,
          models: session.models ?? null,
          loadSession: capabilities.agentCapabilities?.loadSession === true,
        };
        persist(); // Identity is durable before session/prompt.
        if (this.cancelled) {
          client.cancel();
          return;
        }
        const result = await client.prompt(payload.prompt);
        this.stopReason = result?.stopReason;
        this.record = { ...this.record, state: 'TURN_FINISHED', stopReason: result?.stopReason ?? 'unknown' };
        persist();
        this.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'office/acp-stop',
            params: { sessionId: session.sessionId, stopReason: result?.stopReason },
          }) + '\n',
        );
      } catch (error) {
        if (error instanceof AcpProviderError) this.providerError = error.message;
        if (!this.cancelled) {
          this.record = { ...this.record, state: 'ERROR', detail: String(error).slice(0, 1800) };
          try {
            persist();
          } catch {}
          this.stderr.write(String(error) + '\n');
        }
      } finally {
        client.stop();
      }
    })();
  }
  async cancelTurn(timeout = 3000): Promise<boolean> {
    this.cancelled = true;
    this.client.cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.turnFinished,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeout);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return this.stopReason === 'cancelled';
  }
  kill(): boolean {
    if (this.completed) return false;
    this.cancelled = true;
    this.client.cancel();
    this.client.stop();
    return true;
  }
}
