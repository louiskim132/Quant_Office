import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { CapabilityEvidence, Effort, JobEvent, Provider, ProviderJob } from '../shared/types.js';
import type { LocalSessionRecord } from '../shared/local-session.js';
import { mountsEvidenceSurface, type ToolProfile } from '../shared/tool-profile.js';
import type { EvidenceCaller } from './evidence-tool.js';
import { QUERIES_DIR, QUERY_SETTLE_MS, isQueryFile, prepareEvidenceDropbox, serveEvidenceQuery, type EvidenceFrameHandler } from './evidence-dropbox.js';
import { serenaNotInstalled, spawnSerenaSession, type SerenaSpawn } from './serena-session.js';
import { MAX_FILE } from './artifacts.js';
import type { LaunchRequest } from './handoff.js';
import { GuardedLocalFileIO, type LocalFileIO } from './local-session-files.js';
import { CANCEL_ACK_FILE, PACKET_FILE, RESULT_FILE, RESULT_STATES, packetPromptBlock, prepareLocalPacket, readLocalCancelAck, readLocalResult, writeLocalCancelRequest } from './local-packet.js';
import { discover, type Discovery } from './local-provider-records.js';
import { mapToolFlags, providerAttachesMcp, type ToolFlagResult } from './tool-flags.js';
import { subscriptionEnvironment } from './subscriptions.js';
import { NotLaunchedError } from './controller.js';
import type { ObserveResult, ProviderAdapter, SubmitContext, SubmitResult } from './controller.js';

/** The recorded source of every observation this adapter produces. */
const EVIDENCE_SOURCE = 'office-local-cli-exec@1';
/**
 * The launch-plan preview's stand-in for the packet essentials block: the preview runs before a
 * packet exists, so it names the contract the way a user-launched session would read it. A real
 * launch appends packetPromptBlock(prepared) instead — derived from the written packet. Fixed by
 * the adapter — never renderer input.
 */
const PROMPT_SUFFIX = 'This directory is an office-local-session@2 packet: read packet.json and CONTRACT.md, place declared outputs under outputs/, then write result.json exactly as CONTRACT.md specifies.';
/**
 * The minimum spacing between two claude CLI launches from this office. Parallel hops (the two
 * planner drafts, the critiques) spawned claude processes within milliseconds of each other, and
 * concurrent sessions race on the shared OAuth token refresh — observed 2026-09-25 as a brief
 * that died with "another Claude Code process is refreshing it", a whole wasted hop each time.
 */
export const CLAUDE_SPAWN_GAP_MS = 4000;
/** A run that has not reported is killed after this long — an office decision, not a provider timeout. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Buffered child output is evidence, not a transcript — bounded so a chatty process cannot grow memory. */
const MAX_BUFFERED_LINES = 500;
const MAX_BUFFERED_BYTES = 256 * 1024;
/** Drain the entire bounded buffer so an idle burst or terminal cleanup cannot strand its tail. */
const MAX_EVENTS_PER_OBSERVE = MAX_BUFFERED_LINES;
/**
 * The spawn surface the adapter needs — a subset of node's spawn result, so tests can drive a
 * scripted child without a real process.
 */
export interface CliChild {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
export interface CliSpawnOptions { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean; stdio: ['ignore', 'pipe', 'pipe'] }
export type CliSpawn = (executable: string, args: string[], options: CliSpawnOptions) => CliChild;

/** What the office recorded about the process it launched — the evidence payload, verbatim. */
export interface LaunchRecord {
  route: 'LOCAL_CLI_EXEC';
  provider: Provider;
  pid: number | undefined;
  executable: string;
  /** The exact argv, with the prompt slot replaced by a '<prompt:sha256>' marker — provable, compact. */
  args: string[];
  /** The exact trust/permission-bypass flags in the argv, verbatim. */
  bypassFlags: string[];
  spawnedAt: string;
  cwd: string;
  timeoutMs: number;
  requestedModel: string;
  requestedEffort: Effort;
  /** The documented flag the requested effort was carried by, when the CLI documents one. */
  effortFlag: string | null;
  /** A requested effort the CLI has no documented flag for — recorded, never silently dropped. */
  unmappedEffort: Effort | null;
  /** Declared tool-profile restrictions a verified CLI flag actually carries at this launch. */
  appliedRestrictions: string[];
  /**
   * Declared tool-profile restrictions the installed CLI cannot express. Each entry names the
   * restriction and spells out 'declared, not enforced by <provider>' — recorded verbatim so
   * the launch never implies a boundary that does not exist.
   */
  unmappedRestrictions: string[];
}

interface BufferedLine { seq: number; stream: 'stdout' | 'stderr'; text: string; bytes: number; at: string }
interface SpawnRecord {
  jobId: string;
  child: CliChild;
  launch: LaunchRecord;
  /** The packet directory this record runs in — the watcher reads receipts only from here. */
  dir: string;
  lines: BufferedLine[];
  bufferedBytes: number;
  /** Lines dropped to bound memory — never emitted as events. */
  dropped: number;
  seq: number;
  /** Tail bytes of each stream not yet terminated by a newline. */
  pendingOut: string;
  pendingErr: string;
  exit: { code: number | null; signal: string | null; at: string } | null;
  spawnError: string | null;
  /** Set when the office terminated the child (cancel or timeout) — the kill reason, verbatim. */
  officeKill: string | null;
  /** Highest line sequence already emitted as a job event. */
  drainCursor: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Watches the packet directory for the receipt or a cancel ack — auto-observe without polling. */
  watcher: FSWatcher | null;
  /** Watches the evidence drop-box for query files — present only when the profile mounts the surface. */
  queryWatcher: FSWatcher | null;
  /** Trailing debounce so an exit plus a receipt write collapse into one observation. */
  notifyTimer: ReturnType<typeof setTimeout> | undefined;
}

const sha256Text = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The office-spawned local route (QO-LOCAL-REV §6): instead of writing a packet the user launches,
 * the office writes the same office-local-session@2 packet and then spawns the provider's installed
 * CLI itself — unattended, inside the packet directory, under the subscription environment.
 *
 * What this route is: the office owns a child process and reads the same contract-bound receipt
 * the mailbox reads — prepareLocalPacket, readLocalResult and the cancel-request/ack helpers are
 * the identical functions, so a verified receipt means the same thing on both routes.
 *
 * What this route is not: provider-hosted execution, an isolated context, a sandbox, or provider
 * attestation. The CLI runs under the user's own sign-in and filesystem permissions; the trust/
 * permission flags in the launch record widen the tool's own gate and are recorded verbatim, never
 * hidden. Cancellation is real for an office-owned pid (the sentinel plus a process kill) and
 * advisory for anything else; a pid recorded before an office restart is informational only — the
 * office never claims ownership of a process it did not spawn.
 */
export class LocalCliExecAdapter implements ProviderAdapter {
  readonly route = 'LOCAL_CLI_EXEC' as const;
  // Same provider-agnostic contract as the mailbox — every provider runs the v2 packet shape.
  readonly providers: readonly Provider[] = ['devin', 'claude', 'openai'];
  // The exec route only writes bound v2 packets; there is no unbound v1 fallback.
  readonly packetVersion = 2;
  /**
   * The live-process registry. In-memory by design: a pid is only office-owned while the process
   * that spawned it lives; a binding that outlives this office process reports liveness as
   * informational, never as ownership.
   */
  private readonly registry = new Map<string, SpawnRecord>();
  /** Serializes claude launches so consecutive spawns are at least claudeSpawnGapMs apart. */
  private claudeLaunches: Promise<void> = Promise.resolve();
  private lastClaudeLaunchAt = 0;

  constructor(
    private readonly sessionsRoot: () => string,
    /**
     * Resolves the installed CLI path for a provider. The production wiring passes the
     * subscriptions toolPath resolver; the bare-name default lets spawn resolve it on PATH.
     */
    private readonly executable: (provider: Provider) => string = provider => provider,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly io: LocalFileIO = new GuardedLocalFileIO(),
    private readonly spawnChild: CliSpawn = (command, args, options) => spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: options.windowsHide, stdio: options.stdio }),
    /** The child's environment — scrubbed of agent-shell variables that mask CLI sign-in state. */
    private readonly environment: () => NodeJS.ProcessEnv = subscriptionEnvironment,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly discoverRecords: (dir: string, provider: Provider) => Discovery = discover,
    /** Resolves an agent record's provider for plan previews, which run before a binding exists. */
    private readonly providerFor?: (agentId: string) => Provider | undefined,
    /**
     * Fired after a child exit or a receipt/ack write settles — the office observes the job and
     * advances the chain. In-memory only: a run from a previous office process is covered by
     * startup reconciliation, never by a listener on a process this office did not spawn.
     */
    private readonly onLocalEvent?: (jobId: string) => void,
    /**
     * Spawns the office-side serena readiness probe — stdin must be a pipe so the initialize
     * handshake can be written; the exec spawn's pinned 'ignore' stdin cannot serve.
     */
    private readonly serenaSpawn: SerenaSpawn = (command, args, options) => spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: options.windowsHide, stdio: options.stdio }),
    /** Probe deadline override for tests; serena-session supplies the 30s default. */
    private readonly serenaReadyTimeoutMs?: number,
    /**
     * The office-bound edge of the evidence drop-box, bound to EvidenceService at construction.
     * The caller identity comes from the assignment record at submit — never from file bytes.
     */
    private readonly evidenceFrames?: EvidenceFrameHandler,
    /** The claude launch spacing; tests pass 0. */
    private readonly claudeSpawnGapMs: number = CLAUDE_SPAWN_GAP_MS,
  ) {}

  /** Waits until a claude launch would be at least claudeSpawnGapMs after the previous one. */
  private claudeLaunchSlot(): Promise<void> {
    const slot = this.claudeLaunches.then(async () => {
      const wait = this.lastClaudeLaunchAt + this.claudeSpawnGapMs - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      this.lastClaudeLaunchAt = Date.now();
    });
    this.claudeLaunches = slot.catch(() => undefined);
    return slot;
  }

  /**
   * The documented argv for each installed CLI (docs/cli-exec-probes.md), built by
   * mapToolFlags in tool-flags.ts — every flag was verified against the installed tool's
   * --help at development time:
   *   claude 2.1.x: -p, --output-format json, --dangerously-skip-permissions, --model, --effort.
   *   codex:        exec, -s workspace-write, --skip-git-repo-check, -m, -c model_reasoning_effort=…
   *   devin 3000.x: -p, --model, --respect-workspace-trust, --permission-mode (no effort flag).
   * Devin runs `--permission-mode dangerous`: the probed `auto` and `accept-edits` modes both get
   * the write tool rejected in non-interactive use, so dangerous is the least mode that actually
   * covers the contract's workspace writes. It is recorded verbatim in the launch record — a real
   * widening of the tool's own gate, never silently widened further.
   * A binding's declared toolProfile adds only flags verified in the installed --help; every
   * restriction no flag expresses lands in unmappedRestrictions instead of being dropped.
   */
  private providerCommand(provider: Provider, prompt: string, model: string, effort: Effort, profile?: ToolProfile, delegation = false): ToolFlagResult {
    return mapToolFlags({ provider, model, effort, prompt, profile, delegation });
  }

  /**
   * Mounts the office-owned half of a declared tool surface before the provider CLI spawns.
   * A serena entry gets a readiness probe: the office spawns the declared server itself and
   * requires an observed initialize handshake — a declared-but-dead server refuses the launch
   * rather than letting the arm run underprovisioned (the provider attaches its own instance
   * through the emitted MCP config where the provider maps one). A readOnly entry also writes
   * `.serena/project.yml` — the documented mechanism on the pinned build. An evidence-surface
   * entry mounts the queries/answers drop-box in the packet. Returns the honest detail text
   * for the launch record; every failure path throws before the provider spawn.
   */
  private async prepareToolSurface(binding: LocalSessionRecord, dir: string): Promise<{ note: string; profile: ToolProfile | undefined }> {
    let profile = binding.toolProfile;
    const notes: string[] = [];
    // The office probes a declared serena only when the provider can actually attach it —
    // a provider whose CLI cannot reach MCP servers already records the entry as unmapped;
    // blocking its launch over a server that could never serve the run would be the dishonest
    // gate.
    const serenaEntry = profile?.mcpServers?.find(server => server.id === 'serena');
    if (serenaEntry && providerAttachesMcp(binding.provider)) {
      if (serenaEntry.readOnly) {
        try {
          const serenaDir = path.join(dir, '.serena');
          mkdirSync(serenaDir, { recursive: true });
          this.io.inspectRoot(serenaDir);
          this.io.writeNew(dir, '.serena/project.yml', Buffer.from('read_only: true\n', 'utf8'));
          notes.push('serena read_only written to .serena/project.yml');
        } catch {
          notes.push('a .serena/project.yml was already present — read_only relies on the probe\'s fail-closed flag alone');
        }
      }
      const probe = spawnSerenaSession({ binding, profile: profile!, packetDir: dir }, { spawn: this.serenaSpawn, readyTimeoutMs: this.serenaReadyTimeoutMs });
      const ready = await probe.ready;
      probe.dispose();
      // An absent executable is an optional tool that is not installed here, not a dead server: the
      // arm runs without code navigation and the launch record says so. External tools are never a
      // prerequisite; a serena that is installed but fails its handshake still refuses the launch.
      if (!ready.ok && serenaNotInstalled(ready.reason)) {
        profile = { ...profile!, mcpServers: profile!.mcpServers!.filter(server => server.id !== 'serena') };
        notes.push(`serena is not installed on this machine (${ready.reason}) — the arm launched without code navigation; install serena-agent to attach it`);
      } else if (!ready.ok)
        throw new Error(`The declared serena MCP server failed its office readiness probe — ${ready.reason}. The session was not launched.`);
      else notes.push('serena readiness probe passed (initialize handshake observed)');
    }
    if (mountsEvidenceSurface(profile)) {
      if (!this.evidenceFrames)
        throw new Error('The tool profile declares the office evidence surface but this adapter was built without an evidence frame handler; the session was not launched.');
      prepareEvidenceDropbox(dir, this.io);
      notes.push('office evidence surface mounted at queries/ + answers/');
    }
    return { note: notes.length ? ` ${notes.join('; ')}.` : '', profile };
  }

  async submit(context: SubmitContext): Promise<SubmitResult> {
    const binding = context.localSession;
    if (!binding)
      throw new NotLaunchedError('A LOCAL_CLI_EXEC submission requires a persisted local-session binding — the exec route never writes unbound packets.');
    if (binding.packetVersion !== 2 || binding.layout !== 'FLAT_PACKET')
      throw new NotLaunchedError(`A LOCAL_CLI_EXEC submission requires a flat office-local-session@2 binding; this record describes ${binding.layout} packetVersion ${binding.packetVersion}.`);
    const dir = path.resolve(this.sessionsRoot(), binding.storageRelativePath);
    // Everything before the spawn is a NotLaunchedError: a packet that was never written or a
    // probe that refused means no child could have come into existence — there is no provider
    // ambiguity to report, and the controller records that honestly rather than UNKNOWN.
    let prepared: ReturnType<typeof prepareLocalPacket>;
    try {
      prepared = prepareLocalPacket({ dir, context, binding, io: this.io, now: this.now(), memoryDigest: context.memoryDigest });
    } catch (error) {
      throw new NotLaunchedError(error instanceof Error ? error.message : 'The session packet could not be written.');
    }
    let surfaceNote: string, launchProfile: ToolProfile | undefined;
    try {
      ({ note: surfaceNote, profile: launchProfile } = await this.prepareToolSurface(binding, dir));
    } catch (error) {
      throw new NotLaunchedError(error instanceof Error ? error.message : 'The tool-surface probe refused the launch.');
    }
    // The evidence drop-box watcher attaches before the provider spawn so a watch that cannot
    // start refuses the launch cleanly instead of leaving a declared surface silently deaf.
    let queryWatcher: FSWatcher | null = null;
    if (mountsEvidenceSurface(binding.toolProfile) && this.evidenceFrames) {
      const caller: EvidenceCaller = { agentId: context.assignment.agentId, projectId: context.assignment.projectId, requestId: context.assignment.requestId, assignmentId: context.assignment.id };
      const frames = this.evidenceFrames;
      try {
        // realpathSync.native resolves 8.3 short-name aliases (RUNNER~1) that the plain variant
        // preserves — a short-name watch target trips libuv's fs-event prefix assertion on
        // Windows, and that crash would take down the whole office process.
        queryWatcher = watch(realpathSync.native(path.join(dir, QUERIES_DIR)), (_event, name) => {
          if (!isQueryFile(name)) return;
          // A just-created query file gets a beat to flush before the office reads it.
          const settle = setTimeout(() => {
            void serveEvidenceQuery({ dir, io: this.io, name, caller, frames }).catch(() => { /* failures are reported inside the answers stream */ });
          }, QUERY_SETTLE_MS);
          settle.unref?.();
        });
        queryWatcher.unref?.();
      } catch (error) {
        throw new NotLaunchedError(`The declared evidence surface drop-box could not be watched: ${error instanceof Error ? error.message : String(error)}. The session was not launched.`);
      }
    }
    const prompt = `${context.payload.text}\n\n${packetPromptBlock(prepared, context.assignment.pipelineKey)}`;
    const command = this.providerCommand(binding.provider, prompt, context.payload.model, context.payload.effort, launchProfile, context.payload.delegation ?? false);
    let executable: string;
    try {
      executable = this.executable(binding.provider);
    } catch (error) {
      try { queryWatcher?.close(); } catch { /* the launch refusal is the record that matters */ }
      throw new NotLaunchedError(error instanceof Error ? error.message : `The ${binding.provider} CLI executable could not be resolved.`);
    }
    if (binding.provider === 'claude' && this.claudeSpawnGapMs > 0) await this.claudeLaunchSlot();
    let child: CliChild;
    try {
      child = this.spawnChild(executable, command.args, {
        // The spawn cwd is authoritative — codex -C does not place the model's shell (probe doc).
        cwd: dir, env: this.environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      try { queryWatcher?.close(); } catch { /* the launch refusal is the record that matters */ }
      throw error;
    }
    const launch: LaunchRecord = {
      route: this.route, provider: binding.provider, pid: child.pid, executable,
      args: command.args.map(arg => (arg === prompt ? `<prompt:${sha256Text(prompt)}>` : arg)),
      bypassFlags: command.bypassFlags, spawnedAt: this.now(), cwd: dir, timeoutMs: this.timeoutMs,
      requestedModel: context.payload.model, requestedEffort: context.payload.effort,
      effortFlag: command.effortFlag, unmappedEffort: command.unmappedEffort,
      appliedRestrictions: command.applied, unmappedRestrictions: command.unmapped,
    };
    const record: SpawnRecord = {
      jobId: binding.jobId, child, launch, dir,
      lines: [], bufferedBytes: 0, dropped: 0, seq: 0, pendingOut: '', pendingErr: '',
      exit: null, spawnError: null, officeKill: null, drainCursor: 0, timer: undefined,
      watcher: null, queryWatcher, notifyTimer: undefined,
    };
    this.registry.set(binding.jobId, record);
    // A receipt or cancel ack landing in the packet directory is itself the observation trigger —
    // the office never polls. A failed watch degrades to the exit trigger and manual observe,
    // which read the same files.
    try {
      record.watcher = watch(realpathSync.native(dir), (_event, name) => {
        if (name === RESULT_FILE || name === CANCEL_ACK_FILE) this.notify(record.jobId);
      });
      record.watcher.unref?.();
    } catch { /* the exit trigger still fires; nothing is claimed from silence */ }
    child.stdout?.on('data', chunk => this.pushChunk(record, 'stdout', String(chunk)));
    child.stderr?.on('data', chunk => this.pushChunk(record, 'stderr', String(chunk)));
    child.on('exit', (code, signal) => {
      record.exit = { code, signal, at: this.now() };
      if (record.pendingOut) { this.pushLine(record, 'stdout', record.pendingOut); record.pendingOut = ''; }
      if (record.pendingErr) { this.pushLine(record, 'stderr', record.pendingErr); record.pendingErr = ''; }
      if (record.timer) clearTimeout(record.timer);
      this.notify(record.jobId);
    });
    child.on('error', error => { record.spawnError = error.message; });
    record.timer = setTimeout(() => {
      if (record.exit || record.officeKill) return;
      record.officeKill = `the office's ${Math.round(this.timeoutMs / 60000)}-minute run limit elapsed`;
      try { child.kill(); } catch { /* a failed kill leaves the exit record to report what is true */ }
    }, this.timeoutMs);
    // A pending run-limit timer is bookkeeping, not work — it must never hold the process open.
    record.timer.unref?.();
    return {
      externalId: path.basename(binding.storageRelativePath),
      externalUrl: '',
      detail: `Packet written to ${dir} and ${binding.provider} CLI spawned unattended (pid ${child.pid ?? 'unreported'}). The office owns the process; the receipt arrives through ${RESULT_FILE}.${surfaceNote}`,
      localPacket: { packetHash: prepared.packetHash },
    };
  }

  /**
   * Debounced delivery of a local run event to the office. A process exit and the receipt it may
   * leave behind often land together; the trailing delay collapses them into one observation and
   * gives a just-written receipt a moment to flush before the read.
   */
  private notify(jobId: string): void {
    const record = this.registry.get(jobId);
    if (!record) return;
    if (record.notifyTimer) clearTimeout(record.notifyTimer);
    record.notifyTimer = setTimeout(() => {
      record.notifyTimer = undefined;
      try { this.onLocalEvent?.(jobId); } catch { /* a listener failure never reaches process bookkeeping */ }
    }, 750);
    record.notifyTimer.unref?.();
  }

  /**
   * Releases every OS resource one spawn record holds — the directory watcher and both timers —
   * and drops the record. An unref'd handle is the right lifetime hint but is not disposal:
   * watchers must be closed or they accumulate for the life of the office process. Called the
   * moment a job's outcome is verified terminal; a still-open job keeps its triggers.
   */
  private dispose(jobId: string): void {
    const record = this.registry.get(jobId);
    if (!record) return;
    try { record.watcher?.close(); } catch { /* a dead watcher reports nothing */ }
    record.watcher = null;
    try { record.queryWatcher?.close(); } catch { /* a dead watcher reports nothing */ }
    record.queryWatcher = null;
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    if (record.notifyTimer) clearTimeout(record.notifyTimer);
    record.notifyTimer = undefined;
    this.registry.delete(jobId);
  }

  /** Releases all spawn bookkeeping — the office calls this when it goes away. */
  disposeAll(): void {
    for (const jobId of [...this.registry.keys()]) this.dispose(jobId);
  }

  /** Buffers one output chunk into lines; retained volume is capped, drops are counted honestly. */
  private pushChunk(record: SpawnRecord, stream: 'stdout' | 'stderr', chunk: string): void {
    const previousSequence = record.seq;
    const key = stream === 'stdout' ? 'pendingOut' : 'pendingErr';
    record[key] += chunk;
    let index;
    while ((index = record[key].search(/\r?\n/)) >= 0) {
      const line = record[key].slice(0, index);
      record[key] = record[key].slice(index).replace(/^\r?\n/, '');
      this.pushLine(record, stream, line);
    }
    // Surface available tool output without waiting for a receipt or process exit. Do not keep
    // resetting the timer on a busy stream: the office gets a bounded update every 750 ms.
    if (record.seq !== previousSequence && !record.notifyTimer) this.notify(record.jobId);
  }

  private pushLine(record: SpawnRecord, stream: 'stdout' | 'stderr', text: string): void {
    record.lines.push({ seq: ++record.seq, stream, text, bytes: Buffer.byteLength(text), at: this.now() });
    record.bufferedBytes += Buffer.byteLength(text);
    while (record.lines.length > MAX_BUFFERED_LINES || record.bufferedBytes > MAX_BUFFERED_BYTES) {
      const dropped = record.lines.shift();
      if (!dropped) break;
      record.bufferedBytes -= dropped.bytes;
      if (dropped.seq > record.drainCursor) record.dropped += 1;
    }
  }

  /**
   * Drains buffered child output into job events — the provider tool's own words, so the evidence
   * is PROVIDER_REPORTED even though the office collected it. Sequence-keyed cursors dedupe
   * repeats; emission is capped per observation and bounded in memory by the buffer caps.
   */
  private drainEvents(record: SpawnRecord): Omit<JobEvent, 'id' | 'jobId'>[] {
    const fresh = record.lines.filter(line => line.seq > record.drainCursor).slice(0, MAX_EVENTS_PER_OBSERVE);
    if (fresh.length) record.drainCursor = fresh[fresh.length - 1].seq;
    const owner = record.launch.pid ?? 'unowned';
    return fresh.map(line => ({
      externalId: `spawn:${owner}:${line.seq}`,
      cursor: `spawn:${owner}:${line.seq}`,
      kind: 'MESSAGE' as const,
      text: line.text,
      occurredAt: line.at,
      receivedAt: this.now(),
      evidence: 'PROVIDER_REPORTED' as const,
    }));
  }

  /**
   * What the office can honestly say about the process behind this job. An owned child reports
   * exactly what it is doing; a recorded pid without an owned child is checked with signal 0 and
   * reported as informational — the office does not claim ownership of a process it did not spawn.
   */
  private liveness(job: ProviderJob, record: SpawnRecord | undefined): string {
    if (record) {
      const pid = record.launch.pid;
      if (record.officeKill) return `office terminated the spawned process${pid ? ` ${pid}` : ''} (${record.officeKill})`;
      if (record.exit) return `spawned process${pid ? ` ${pid}` : ''} exited (code ${record.exit.code}${record.exit.signal ? `, signal ${record.exit.signal}` : ''})`;
      if (record.spawnError) return `the spawned process${pid ? ` ${pid}` : ''} reported an error (${record.spawnError})`;
      return `office-spawned process${pid ? ` ${pid}` : ''} is still running`;
    }
    const recorded = Number(job.detail.match(/pid (\d+)/)?.[1]);
    if (!Number.isInteger(recorded) || recorded <= 0) return 'no spawned process is recorded for this job';
    try {
      process.kill(recorded, 0);
      return `a process with the recorded pid ${recorded} is alive, but this office process did not spawn it — liveness is informational; the office does not claim ownership`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return `the recorded pid ${recorded} is not running`;
      if (code === 'EPERM') return `a process with the recorded pid ${recorded} exists but cannot be signalled by this office — liveness is informational; the office does not claim ownership`;
      return `the recorded pid ${recorded} could not be checked (${error instanceof Error ? error.message : 'unknown error'})`;
    }
  }

  async observe(job: ProviderJob, local?: LocalSessionRecord | null, replay?: { receiptHash: string }): Promise<ObserveResult> {
    const unknown = (detail: string): ObserveResult => ({ state: 'UNKNOWN', detail, provenance: 'OFFICE_LOCAL' });
    if (!local)
      return unknown('A LOCAL_CLI_EXEC observation requires the persisted local-session binding; without it the office cannot name the packet directory.');
    if (local.packetVersion !== 2 || local.layout !== 'FLAT_PACKET')
      return unknown(`This binding describes ${local.layout} packetVersion ${local.packetVersion}, which this adapter does not read — reconcile it against the flat office-local-session@2 contract.`);
    const dir = path.resolve(this.sessionsRoot(), local.storageRelativePath);
    const record = this.registry.get(job.id);
    const events = record ? this.drainEvents(record) : undefined;
    // Read-only provider-record discovery, identical to the mailbox's — an office observation of
    // provider-side grouping, independent of receipt state. OBSERVED pins; nothing is inferred
    // from absence and a discovery failure is not a defect.
    const grouping = local.groupingStatus !== 'OBSERVED' ? this.discoverGrouping(dir, local) : undefined;
    // A terminal observation never carries the liveness bracket — 'still running' beside a
    // COMPLETED or FAILED outcome is a stale claim. The dropped-lines note still rides alone.
    const attach = (result: ObserveResult, terminal = false): ObserveResult => ({
      ...result,
      detail: terminal
        ? `${result.detail}${record?.dropped ? ` [${record.dropped} earlier output lines were dropped to bound memory]` : ''}`
        : `${result.detail} [${this.liveness(job, record)}${record?.dropped ? `; ${record.dropped} earlier output lines were dropped to bound memory` : ''}]`,
      ...(events?.length ? { events } : {}),
      ...(grouping ? { providerGrouping: grouping } : {}),
    });
    if (!existsSync(dir))
      return attach(unknown('The session directory for this job is not present under the workspace sessions root — it may have been retired or removed externally; nothing has been heard from a local session.'));
    // An office-killed run is failed work: the office ended the process, so a receipt it may never
    // write is not awaited. This is the office's own kill — OFFICE_LOCAL, not a provider report.
    // The outcome is terminal here, so the spawn's watcher and timers are released with it.
    if (record?.officeKill) {
      this.dispose(job.id);
      return attach({ state: 'FAILED', detail: `office terminated the spawned process (${record.officeKill}); a killed run cannot be trusted to write a receipt`, provenance: 'OFFICE_LOCAL' }, true);
    }
    // A cancel acknowledgement is a control file: it is validated before the receipt is read, and
    // a malformed or misbound one makes the whole observation UNKNOWN — a bad control file is
    // never ignored to reach a good receipt.
    const ack = readLocalCancelAck(dir, local, this.io);
    if ('defect' in ack) return attach(unknown(ack.defect));
    // The v2 reader proves the ready marker, the attempt binding, the sequence and every declared
    // output byte before anything is reported — the same reader the mailbox runs.
    const read = readLocalResult(dir, local, this.io, replay ? { allowReceiptHash: replay.receiptHash } : undefined);
    if ('defect' in read) {
      if (record?.exit && !record.officeKill) {
        // A self-exited process is not a failure claim — but the provider's own terminal record
        // in its output is. When the CLI reported is_error, that is what the job is.
        const terminalError = this.providerTerminalError(record);
        if (terminalError) {
          this.dispose(job.id);
          return attach({ state: 'FAILED', detail: terminalError.detail, provenance: 'PROVIDER_REPORTED',
            ...(terminalError.transient ? { transientProviderError: true } : {}) }, true);
        }
        return attach(unknown(`${read.defect} The spawned process exited on its own (code ${record.exit.code}${record.exit.signal ? `, signal ${record.exit.signal}` : ''}) without a trusted receipt — no receipt, no provider error record; a self-exit is not a failure claim.`));
      }
      return attach(unknown(read.defect));
    }
    const result = read.value.result;
    const observed: ObserveResult = {
      state: result.state, detail: result.detail,
      outputs: result.outputs.map(output => ({ path: output.path, sha256: output.sha256, bytes: output.bytes })),
      provenance: 'PROVIDER_REPORTED',
    };
    if (result.applied) {
      const applied: NonNullable<ObserveResult['applied']> = {};
      if (result.applied.model !== undefined) applied.model = result.applied.model;
      if (result.applied.effort !== undefined) applied.effort = result.applied.effort;
      if (result.applied.delegation !== undefined) applied.delegation = result.applied.delegation;
      if (applied.model !== undefined || applied.effort !== undefined || applied.delegation !== undefined) observed.applied = applied;
    }
    if (ack.ack) observed.cancelAck = ack.ack;
    // The receipt's self-reported memory sections ride the same verified-observation channel —
    // ingest validates each entry against the ledger before anything lands.
    if (result.findings?.length || result.links?.length) observed.memory = { ...(result.findings ? { findings: result.findings } : {}), ...(result.links ? { links: result.links } : {}) };
    // The verified receipt's identity rides to the caller — the binding persists it as lastReceipt
    // so a replayed or rewound receipt is refused on the next observation.
    observed.receipt = { sequence: result.sequence, hash: read.value.receiptHash };
    // A verified terminal receipt or a cooperative cancel acknowledgement ends the spawn's watch:
    // nothing this watcher could still report would change the recorded outcome.
    if (result.state === 'COMPLETED' || result.state === 'FAILED' || ack.ack) this.dispose(job.id);
    return attach(observed, result.state === 'COMPLETED' || result.state === 'FAILED');
  }

  /**
   * The provider's own terminal record in the drained output. Only claude's `--output-format
   * json` stream documents one — the last `{"type":"result"}` line — so codex/devin output is
   * never classified here. `is_error: true` is a provider-reported failure the office reports
   * verbatim; a success record or no record is not a failure claim. The single documented
   * transient signature — `terminal_reason` 'api_error' over an OAuth-refresh failure text —
   * flags transientProviderError for the office's one-shot retry; nothing else qualifies.
   */
  private providerTerminalError(record: SpawnRecord): { detail: string; transient: boolean } | undefined {
    if (record.launch.provider !== 'claude') return undefined;
    for (let index = record.lines.length - 1; index >= 0; index--) {
      const line = record.lines[index];
      if (line.stream !== 'stdout') continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line.text); } catch { continue; }
      if (!parsed || typeof parsed !== 'object' || (parsed as { type?: unknown }).type !== 'result') continue;
      const terminal = parsed as { is_error?: unknown; result?: unknown; errors?: unknown; terminal_reason?: unknown };
      if (terminal.is_error !== true) return undefined;
      const text = typeof terminal.result === 'string' && terminal.result
        ? terminal.result
        : Array.isArray(terminal.errors) ? terminal.errors.filter(item => typeof item === 'string').join(' ') : '';
      return {
        detail: `the provider reported a terminal error${text ? `: ${text.slice(0, 3900)}` : ''}`,
        transient: terminal.terminal_reason === 'api_error' && /failed to refresh oauth token/i.test(text),
      };
    }
    return undefined;
  }

  /** The same read-only provider-record discovery the mailbox runs. */
  private discoverGrouping(dir: string, binding: LocalSessionRecord): { key: string; kind: string } | undefined {
    try {
      const found = this.discoverRecords(dir, binding.provider);
      return found.records.length ? { key: found.records[0].id, kind: found.records[0].kind } : undefined;
    } catch { return undefined; }
  }

  async cancel(job: ProviderJob, local?: LocalSessionRecord | null): Promise<{ acknowledged: boolean; detail: string; requestId?: string }> {
    if (!local || local.packetVersion !== 2 || local.layout !== 'FLAT_PACKET')
      return { acknowledged: false, detail: 'A LOCAL_CLI_EXEC cancellation requires a flat office-local-session@2 binding; nothing was written and no process was signalled.' };
    const dir = path.resolve(this.sessionsRoot(), local.storageRelativePath);
    // The shared sentinel writer — identical read-first idempotency and identity binding as the
    // mailbox. acknowledged means the office DELIVERED a request, never that anything stopped.
    const sentinel = writeLocalCancelRequest({ dir, binding: local, io: this.io, now: this.now() });
    const record = this.registry.get(job.id);
    const live = record && !record.exit && !record.spawnError && !record.officeKill;
    let processClause: string;
    if (live && record) {
      record.officeKill = 'cancelled by the office — the cooperative sentinel was written and the spawned process was terminated';
      if (record.timer) clearTimeout(record.timer);
      try { record.child.kill(); } catch { /* the exit record reports what actually happened */ }
      processClause = `the office terminated the spawned process${record.launch.pid ? ` (pid ${record.launch.pid})` : ''} — a real cancellation of that process, not a provider acknowledgement`;
    } else {
      const why = record?.officeKill ? `the office already terminated it (${record.officeKill})`
        : record?.exit ? `the spawned process already exited (code ${record.exit.code})`
        : record?.spawnError ? `the spawned process reported an error (${record.spawnError})`
        : 'no office-spawned process is recorded for this job';
      processClause = `no office-owned process is alive — the sentinel is advisory (${why})`;
    }
    return { ...sentinel, detail: `${sentinel.detail} Additionally, ${processClause}.` };
  }

  async fetch(job: ProviderJob, output: { path: string; sha256: string; bytes: number }, local?: LocalSessionRecord | null): Promise<Uint8Array> {
    const dir = local ? path.resolve(this.sessionsRoot(), local.storageRelativePath) : null;
    if (!dir) throw new Error('No session directory is recorded for this job.');
    // The guarded boundary re-proves the path is a real, contained file, and the declared
    // sha256/bytes are re-verified against the bytes actually read before they are returned.
    const file = this.io.read(dir, output.path, MAX_FILE);
    if (file.byteLength !== output.bytes)
      throw new Error(`The declared output ${output.path} is ${file.byteLength} bytes on disk, not the ${output.bytes} the receipt recorded.`);
    if (file.sha256 !== output.sha256)
      throw new Error(`The declared output ${output.path} hashes to ${file.sha256} on disk, not the ${output.sha256} the receipt recorded.`);
    return file.bytes;
  }

  /**
   * The exact command a dispatch on this route would spawn, for the launch-plan preview. `cwd` is
   * the session directory when a binding already names it, else the sessions root the attempt
   * directory will be created under — the real cwd only exists once dispatch writes the packet.
   */
  plan(context: SubmitContext): LaunchRequest {
    const provider = context.localSession?.provider ?? this.providerFor?.(context.assignment.agentId);
    if (!provider) throw new Error('The provider for this launch cannot be resolved, so the exec command cannot be named.');
    const prompt = `${context.payload.text}\n\n${PROMPT_SUFFIX}`;
    const { args } = this.providerCommand(provider, prompt, context.payload.model, context.payload.effort, context.localSession?.toolProfile, context.payload.delegation ?? false);
    return {
      executable: this.executable(provider), args,
      cwd: context.localSession ? path.resolve(this.sessionsRoot(), context.localSession.storageRelativePath) : this.sessionsRoot(),
    };
  }

  /** The scope every observation this adapter records shares: this route, this machine, this source. */
  private evidenceScope(verifiedAt: string): Pick<CapabilityEvidence, 'level' | 'evidence' | 'route' | 'environment' | 'source' | 'verifiedAt'> {
    return { level: 'TOOL_SUPPORTED', evidence: 'OBSERVED', route: this.route, environment: 'LOCAL_MACHINE', source: EVIDENCE_SOURCE, verifiedAt };
  }

  /**
   * Office-observed evidence for one spawned launch. The detail carries the launch record
   * verbatim — pid, executable, the argv with the prompt slot reduced to its hash marker, the
   * exact trust/permission-bypass flags, cwd and timeout — so the evidence is compact and provable
   * rather than a transcript. TOOL_SUPPORTED/OBSERVED at most, never provider attestation.
   */
  submitEvidence(context: SubmitContext, result: SubmitResult): CapabilityEvidence[] {
    const record = this.registry.get(context.jobId);
    const dir = context.localSession ? path.resolve(this.sessionsRoot(), context.localSession.storageRelativePath) : null;
    if (!dir || !existsSync(path.join(dir, PACKET_FILE))) return [];
    const scope = this.evidenceScope(this.now());
    const launch = record?.launch;
    const launchDetail = launch
      ? `office-spawned unattended run: ${JSON.stringify(launch)}`
      : `office-spawned unattended run (the launch record is unavailable to this office process; externalId ${result.externalId})`;
    return [
      {
        ...scope, operation: 'LOCAL_SUBMIT',
        detail: `The office wrote a hash-manifested session packet to a dedicated workspace session directory and spawned the provider CLI inside it — ${launchDetail}. Office-observed, not provider attestation.`,
      },
      {
        ...scope, operation: 'TOOL_CONFINEMENT',
        detail: `Delivery scope, not an enforced boundary: the office spawned the CLI into one dedicated session directory under the user's own permissions. ${this.confinementNote(launch?.provider ?? context.localSession?.provider)}`,
        confinement: {
          tools: this.confinementTools(launch, context.localSession),
          filesystem: 'the packet was written to one dedicated session directory; the office confines nothing — the spawned CLI runs under the user\'s filesystem permissions and can read sibling directories',
          network: 'not restricted by the office; the packet declares what the session may read',
          environment: 'office-spawned provider CLI child process on this machine',
        },
      },
      {
        ...scope, operation: 'DELEGATION_CONTROL', delegation: false,
        detail: 'The packet carries only the frozen single-agent payload; the spawned run has no office delegation channel beyond the CLI\'s own flags.',
      },
    ];
  }

  /**
   * The tools line of the launch's confinement record. It names the packet contents, every
   * profile restriction a verified CLI flag carries, and every restriction left as a declared-
   * only residue — each unmapped entry already spells out 'declared, not enforced by
   * <provider>'. When this office process no longer holds the launch record, the residue is
   * recomputed from the binding's declared profile (applied/unmapped are profile-derived only)
   * and qualified as such.
   */
  private confinementTools(launch: LaunchRecord | undefined, binding: LocalSessionRecord | null | undefined): string {
    const parts = ['packet contents delivered: packet.json, the result contract and declared snapshot inputs'];
    let applied = launch?.appliedRestrictions ?? [];
    let unmapped = launch?.unmappedRestrictions ?? [];
    if (!launch && binding?.toolProfile) {
      const residue = mapToolFlags({ provider: binding.provider, model: '', effort: 'default', prompt: '', profile: binding.toolProfile });
      applied = residue.applied.map(entry => `${entry} (reconstructed from the declared profile — the launch record is unavailable to this office process)`);
      unmapped = residue.unmapped;
    }
    if (applied.length) parts.push(`profile restrictions carried by verified CLI flags: ${applied.join(' | ')}`);
    parts.push(...unmapped);
    return parts.join('; ');
  }

  /** The probed confinement claim for each provider's sandbox flags — exactly what was observed, nothing more. */
  private confinementNote(provider: Provider | undefined): string {
    switch (provider) {
      case 'openai':
        return 'codex was spawned with -s workspace-write — the probe observed it refusing an out-of-workspace cd; Windows read confinement is untested.';
      case 'claude':
        return 'claude was spawned with --dangerously-skip-permissions — the session runs without tool-permission prompts; no provider-side sandbox is claimed.';
      case 'devin':
        return 'devin was spawned with --permission-mode dangerous (the least mode that permits workspace writes non-interactively) — all tools are auto-approved; no provider-side sandbox is claimed.';
      default:
        return 'no provider sandbox claim is recorded.';
    }
  }

  /**
   * Office-observed evidence for one receipt read. Anything short of a fully hash-verified,
   * session-reported result produces nothing: an UNKNOWN reading is the office describing its own
   * silence, not an observation of the session. Self-reported applied facts appear only when the
   * receipt actually declared them.
   */
  observeEvidence(_job: ProviderJob, result: ObserveResult): CapabilityEvidence[] {
    if (result.provenance !== 'PROVIDER_REPORTED' || !(RESULT_STATES as readonly string[]).includes(result.state)) return [];
    const scope = this.evidenceScope(this.now());
    const entries: CapabilityEvidence[] = [{
      ...scope, operation: 'LOCAL_OBSERVE',
      detail: "The office read the session's own result.json from the packet directory of an office-spawned unattended run.",
    }];
    if (result.outputs?.length)
      entries.push({
        ...scope, operation: 'LOCAL_OUTPUT_FETCH',
        detail: `The office read back ${result.outputs.length} declared output file${result.outputs.length === 1 ? '' : 's'} and verified every declared sha256 and byte count against the bytes on disk.`,
      });
    const applied = result.applied;
    if (applied?.model !== undefined)
      entries.push({
        ...scope, operation: 'MODEL_APPLICATION', model: applied.model,
        detail: 'The local session reported applying this model. Session self-report observed by the office, not provider attestation.',
      });
    if (applied?.effort !== undefined)
      entries.push({
        ...scope, operation: 'EFFORT_APPLICATION', effort: applied.effort,
        detail: 'The local session reported applying this effort. Session self-report observed by the office, not provider attestation.',
      });
    if (applied?.delegation !== undefined)
      entries.push({
        ...scope, operation: 'DELEGATION_CONTROL', delegation: applied.delegation,
        detail: 'The local session reported this delegation setting in its receipt. Session self-report observed by the office, not provider attestation.',
      });
    return entries;
  }

  /**
   * Office-observed evidence for one cancellation. A sentinel on disk backs the record; when this
   * office process still owns the child, the record also names the pid it terminated — a real
   * cancellation of that process, never a provider acknowledgement.
   */
  cancelEvidence(job: ProviderJob): CapabilityEvidence[] {
    const dir = job.externalId ? path.join(this.sessionsRoot(), job.externalId) : null;
    if (!dir || !existsSync(path.join(dir, 'cancel.requested'))) return [];
    const record = this.registry.get(job.id);
    return [{
      ...this.evidenceScope(this.now()), operation: 'LOCAL_CANCEL',
      detail: record?.officeKill
        ? `The office ended the office-spawned run by writing the cancel sentinel in the packet directory and terminating the spawned process${record.launch.pid ? ` (pid ${record.launch.pid})` : ''} — a real cancellation of that process, not a provider acknowledgement.`
        : 'The office wrote the cancel sentinel in the packet directory of an office-spawned run; no office-owned process was alive to terminate — the sentinel is advisory, not a provider acknowledgement.',
    }];
  }
}
