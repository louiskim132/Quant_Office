import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ProviderJob } from '../shared/types.js';
import type { ObserveResult, ProviderAdapter, SubmitContext, SubmitResult } from './controller.js';

export interface LaunchRequest {
  executable: string;
  args: string[];
  cwd: string;
}
export interface LaunchResult {
  launched: boolean;
  detail: string;
}

/**
 * Opens a visible official terminal in the staged snapshot directory.
 * A terminal is appropriate here because the user explicitly asked for this handoff; background
 * checks never open one. The office passes fixed arguments; nothing comes from the renderer.
 */
export function openOfficialTerminal(request: LaunchRequest): Promise<LaunchResult> {
  return new Promise(resolve => {
    const shell = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const quoted = [request.executable, ...request.args].map(value => `'${value.replaceAll("'", "''")}'`).join(' ');
    const command = Buffer.from(
      `Set-Location -LiteralPath '${request.cwd.replaceAll("'", "''")}'; & ${quoted}`,
      'utf16le',
    ).toString('base64');
    const child = spawn(
      shell,
      [
        '-NoProfile',
        '-Command',
        `Start-Process -FilePath '${shell.replaceAll("'", "''")}' -ArgumentList @('-NoExit','-NoProfile','-EncodedCommand','${command}')`,
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    child.once('error', error =>
      resolve({ launched: false, detail: `The official terminal could not be opened: ${error.message}` }),
    );
    child.once('exit', code =>
      resolve(
        code === 0
          ? { launched: true, detail: 'The official Claude terminal was opened in the prepared snapshot directory.' }
          : { launched: false, detail: `The launcher exited with code ${code}.` },
      ),
    );
  });
}

export interface HandoffOptions {
  executable: () => string;
  launch?: (request: LaunchRequest) => Promise<LaunchResult>;
}

/**
 * The interim transport: the office prepares everything and opens the official terminal, and the
 * user completes the submission there.
 *
 * Opening a terminal is not a submission. This adapter never returns an identifier, so the
 * controller records Unknown, which is the truthful state until the provider is observed.
 */
export class TerminalHandoffAdapter implements ProviderAdapter {
  readonly route = 'OFFICIAL_TERMINAL_HANDOFF' as const;
  public lastCommand: LaunchRequest | null = null;
  constructor(private readonly options: HandoffOptions) {}

  /** The exact command the user will see, so the UI can show it before anything is launched. */
  plan(context: SubmitContext): LaunchRequest {
    if (!context.snapshot.stagingPath) throw new Error('Prepare the request inputs before handing off.');
    if (!context.snapshot.stagingCommit)
      throw new Error(
        'The prepared snapshot has no commit, which the official cloud route requires. Prepare it again with git available.',
      );
    return {
      executable: this.options.executable(),
      // The documented cloud route only. Never --teleport, --environment, a local background run or a bare prompt.
      args: ['--cloud', context.requestName.slice(0, 120)],
      cwd: context.snapshot.stagingPath,
    };
  }

  async submit(context: SubmitContext): Promise<SubmitResult> {
    const request = this.plan(context);
    this.lastCommand = request;
    const launch = await (this.options.launch ?? openOfficialTerminal)(request);
    // A launcher failure says the office could not open the terminal. It does not establish that the
    // provider saw nothing, because the failure may have come after the tool started, so the old
    // "Nothing was submitted" claim is replaced by what is actually known.
    if (!launch.launched) throw new Error(`${launch.detail} Whether anything reached the provider is unknown.`);
    // A launched terminal, an exit code and an opened browser are all silent about the provider's view.
    return {
      externalId: '',
      externalUrl: '',
      detail: `${launch.detail} The office cannot see whether a session was created, so this work stays Unknown until the provider is observed or you link the session it created.`,
    };
  }

  async observe(_job: ProviderJob): Promise<ObserveResult> {
    return {
      state: 'UNKNOWN',
      detail:
        'No supported programmatic observation exists for a handed-off session on the installed tool. Open the session in the provider UI to see its state.',
    };
  }

  async cancel(_job: ProviderJob): Promise<{ acknowledged: boolean; detail: string }> {
    return {
      acknowledged: false,
      detail:
        'No supported cloud cancellation route has been established for this account. Cancel the session in the provider UI; the office will keep this as cancel requested until a provider acknowledgement is recorded.',
    };
  }
}
