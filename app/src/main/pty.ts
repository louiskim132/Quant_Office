import type { ProviderJob } from '../shared/types.js';
import type { ObserveResult, ProviderAdapter, SubmitContext, SubmitResult } from './controller.js';

/** The slice of node-pty this adapter uses, so tests can drive it without spawning a terminal. */
export interface PtyLike {
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(): void;
}
export interface PtySpawn { (executable: string, args: string[], options: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }): PtyLike }

/** Terminal control sequences carry no evidence; only the visible text is kept. */
export function stripAnsi(value: string): string {
  return value
    // OSC sequences (title changes), then single-character and CSI escapes.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\r(?!\n)/g, '\n');
}

/**
 * The complete creation receipt the official CLI was actually observed to print (roadmap section 13):
 *
 *   Created cloud session: Transport capability fixture
 *   View: https://claude.ai/code/session_01Aj1hpgmeoZLdgYVR9eQ6PB?from=cli&m=0
 *
 * Nothing less counts. The creation line frames the receipt, the view line must carry the official
 * host and path, and the identifier is bounded on both sides so a longer token cannot be truncated
 * into a valid-looking one. The view line must also end in a newline that is already in the buffer:
 * that is what stops a chunk boundary falling inside an identifier from being read as a finished
 * receipt, because a prefix that happens to be long enough is still an unfinished line.
 *
 * An identifier echoed anywhere else, an unrelated host or path, an arbitrary URL and a truncated
 * identifier all fail, because none of them is evidence that the provider created a session.
 */
const RECEIPT = /^[ \t]*Created cloud session:[^\n]*\r?\n[ \t]*View:[ \t]*https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]{16,64})(?![A-Za-z0-9])[^\s]*[ \t]*\r?\n/m;

/** Reads a creation receipt out of accumulated terminal text. Partial chunks simply do not match yet. */
export function readReceipt(text: string): { externalId: string; externalUrl: string } | null {
  const match = stripAnsi(text).match(RECEIPT);
  // The stored URL is rebuilt from the identifier, so CLI query parameters are never persisted.
  return match ? { externalId: match[1], externalUrl: `https://claude.ai/code/${match[1]}` } : null;
}

export interface PtyOptions {
  executable: () => string;
  spawn?: PtySpawn;
  environment?: () => NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Mirrors the flags the one successful terminal creation used. `--cloud` is never removed. */
  hardeningArgs?: string[];
}

/**
 * Creates a cloud session through the official CLI in a real terminal.
 *
 * The installed CLI refuses `--cloud` over a pipe, so a PTY is the only in-app route. This changes
 * the transport, not the rules: an unreadable receipt, a timeout or an early exit all leave the job
 * Unknown, and the office never claims a submission it did not see acknowledged.
 */
export class PtyCloudAdapter implements ProviderAdapter {
  readonly route = 'OFFICIAL_CLI_PTY' as const;
  public lastTranscript = '';
  /** Exactly what was written to the terminal, so a test can compare sent bytes to the preview. */
  public lastPayload = '';
  constructor(private readonly options: PtyOptions) {}

  private spawner(): PtySpawn {
    if (this.options.spawn) return this.options.spawn;
    // Loaded lazily so the app still starts, builds and packages when the native module is absent.
    const required = require('node-pty') as { spawn: PtySpawn };
    return required.spawn;
  }

  plan(context: SubmitContext): { executable: string; args: string[]; cwd: string } {
    if (!context.snapshot.stagingPath) throw new Error('Prepare the request inputs before dispatching.');
    if (!context.snapshot.stagingCommit) throw new Error('The prepared snapshot has no commit, which the official cloud route requires.');
    // This route has no verified way to select a model or an effort. Rather than dropping the
    // request silently and letting whatever the account defaults to run, it is refused.
    if (context.payload.effort !== 'default')
      throw new Error(`This route cannot select an effort, so ${context.payload.effort} cannot be enforced. Use the default, or wait for a route that verifies applied effort.`);
    const hardening = this.options.hardeningArgs ?? ['--safe-mode', '--no-chrome'];
    // Never --teleport, never --environment, never a local background run, and never without --cloud.
    return { executable: this.options.executable(), args: [...hardening, '--cloud', context.requestName.slice(0, 120)], cwd: context.snapshot.stagingPath };
  }

  async submit(context: SubmitContext): Promise<SubmitResult> {
    const plan = this.plan(context);
    const spawn = this.spawner();
    const timeoutMs = this.options.timeoutMs ?? 180000;
    const terminal = spawn(plan.executable, plan.args, { cwd: plan.cwd, cols: 120, rows: 40, env: this.options.environment?.() ?? process.env });
    let transcript = '';
    let settled = false;
    let exited = false;
    return await new Promise<SubmitResult>((resolve, reject) => {
      // Killing a terminal that already exited makes ConPTY complain on Windows, so only kill a live one.
      const finish = (outcome: () => void) => { if (settled) return; settled = true; clearTimeout(timer); if (!exited) { try { terminal.kill(); } catch { /* the terminal may already be gone */ } } this.lastTranscript = stripAnsi(transcript); outcome(); };
      const timer = setTimeout(() => finish(() => reject(new Error(`The official terminal did not report a session within ${Math.round(timeoutMs / 1000)}s. Whether the provider accepted this work is unknown.`))), timeoutMs);
      terminal.onData(chunk => {
        transcript += chunk;
        if (transcript.length > 2 * 1024 * 1024) { finish(() => reject(new Error('The official terminal produced more output than the office will read. The submission outcome is unknown.'))); return; }
        const receipt = readReceipt(transcript);
        if (receipt) finish(() => resolve({ externalId: receipt.externalId, externalUrl: receipt.externalUrl, detail: 'The official CLI reported a created cloud session in a real terminal.' }));
      });
      terminal.onExit(({ exitCode }) => {
        exited = true;
        const receipt = readReceipt(transcript);
        if (receipt) { finish(() => resolve({ externalId: receipt.externalId, externalUrl: receipt.externalUrl, detail: `The official CLI reported a created cloud session and exited with code ${exitCode}.` })); return; }
        // An exit code is not a provider outcome; without a receipt the submission stays unknown.
        finish(() => reject(new Error(`The official terminal exited with code ${exitCode} without reporting a session. Whether the provider accepted this work is unknown.`)));
      });
      // The whole prepared payload, not just the objective. Newlines would submit the prompt early
      // in a terminal, so they are flattened; the transmitted text is retained for comparison with
      // what the user previewed.
      this.lastPayload = context.payload.text;
      terminal.write(`${context.payload.text.replaceAll('\r', ' ').replaceAll('\n', ' ')}\r`);
    });
  }

  async observe(_job: ProviderJob): Promise<ObserveResult> {
    return { state: 'UNKNOWN', detail: 'No supported programmatic observation of a cloud session has been established for this account. Open the session in the provider UI.' };
  }

  async cancel(_job: ProviderJob): Promise<{ acknowledged: boolean; detail: string }> {
    return { acknowledged: false, detail: 'No supported cloud cancellation route has been established for this account. Killing a local terminal does not cancel provider work.' };
  }
}

/** Whether the native terminal module is present in this build. Loaded lazily and never required to start. */
export function transportModuleStatus(): { available: boolean; detail: string } {
  try {
    const loaded = require('node-pty') as { spawn?: unknown };
    return typeof loaded.spawn === 'function'
      ? { available: true, detail: 'The terminal transport module is available in this build.' }
      : { available: false, detail: 'The terminal transport module loaded without a spawn function.' };
  } catch (error) {
    return { available: false, detail: `The terminal transport module is not available: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}` };
  }
}
