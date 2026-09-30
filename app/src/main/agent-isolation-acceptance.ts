import path from 'node:path';

/** Results collected by the manual, real-account LR-16 acceptance runner. */
export interface AgentIsolationProbe {
  label: string;
  code: number | null;
  signal: string | null;
  out: string;
  err: string;
  error?: string;
}

export type AgentIsolationAcceptanceChecks = Record<string, boolean>;

/**
 * Evaluate the real-user probes conservatively. In particular, a missing process or a failed host
 * launch can never count as proof that a protected path was denied or that a cwd escape was refused.
 */
export function evaluateAgentIsolationAcceptance(
  username: string,
  probes: AgentIsolationProbe[],
): AgentIsolationAcceptanceChecks {
  const probe = (label: string) => probes.find(item => item.label === label);
  const whoami = probe('whoami');
  const groups = probe('whoami /groups');
  const profile = probe('office profile read');
  const escape = probe('cwd escape C:\\');

  return {
    'host started and whoami ran': Boolean(whoami && !whoami.error && whoami.code === 0),
    'whoami is qro-agent': Boolean(
      whoami &&
      !whoami.error &&
      whoami.code === 0 &&
      (whoami.out.trim().toLowerCase().endsWith(`\\${username.toLowerCase()}`) ||
        whoami.out.trim().toLowerCase() === username.toLowerCase()),
    ),
    'not an administrator': Boolean(
      groups &&
      !groups.error &&
      groups.code === 0 &&
      !/(?:S-1-5-32-544|(?:BUILTIN\\)?Administrators)/i.test(groups.out),
    ),
    'office profile denied': Boolean(
      profile &&
      !profile.error &&
      profile.code !== null &&
      profile.code !== 0 &&
      /access is denied|permission denied/i.test(`${profile.out}\n${profile.err}`),
    ),
    'cwd escape refused': Boolean(
      whoami &&
      !whoami.error &&
      whoami.code === 0 &&
      escape &&
      escape.error === 'refused: cwd is outside the agent sessions root',
    ),
  };
}

/** The minimal spawn surface the runner needs — satisfied by the office's QroAgentSpawn. */
export type AcceptanceSpawn = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean; stdio: ['ignore', 'pipe', 'pipe'] },
) => {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
};

export interface AgentIsolationAcceptanceInput {
  spawnAs: AcceptanceSpawn;
  username: string;
  /** A folder inside the agent sessions root — the probes' working directory. */
  sessionDir: string;
  /** A folder of the office account the agent account must not be able to list. */
  protectedDir: string;
  /** Outside the sessions root; the host must refuse it as a working directory. */
  escapeCwd?: string;
  system32?: string;
  timeoutMs?: number;
}

export interface AgentIsolationAcceptanceReport {
  username: string;
  probes: AgentIsolationProbe[];
  checks: AgentIsolationAcceptanceChecks;
  passed: boolean;
}

function runProbe(
  spawnAs: AcceptanceSpawn,
  label: string,
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<AgentIsolationProbe> {
  return new Promise(resolve => {
    const out: string[] = [];
    const err: string[] = [];
    let settled = false;
    const finish = (probe: Omit<AgentIsolationProbe, 'label' | 'out' | 'err'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ label, out: out.join(''), err: err.join(''), ...probe });
    };
    let child: ReturnType<AcceptanceSpawn>;
    try {
      child = spawnAs(executable, args, { cwd, env: {}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ label, code: null, signal: null, out: '', err: '', error: (error as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, signal: null, error: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout?.on('data', chunk => out.push(String(chunk)));
    child.stderr?.on('data', chunk => err.push(String(chunk)));
    child.on('error', error => finish({ code: null, signal: null, error: error.message }));
    // Let the tailed logs drain before reading the final output.
    child.on('exit', (code, signal) => setTimeout(() => finish({ code, signal }), 500));
  });
}

/**
 * The real-account LR-16 acceptance, run through the office's own isolated spawn surface so the
 * saved DPAPI credential is used as-is and never rotated. Probes run one after another; the
 * verdict comes only from evaluateAgentIsolationAcceptance, which fails closed.
 */
export async function runAgentIsolationAcceptance(
  input: AgentIsolationAcceptanceInput,
): Promise<AgentIsolationAcceptanceReport> {
  const sys = input.system32 ?? 'C:\\Windows\\System32';
  const whoami = path.win32.join(sys, 'whoami.exe');
  const timeoutMs = input.timeoutMs ?? 60_000;
  const plan: [string, string, string[], string][] = [
    ['whoami', whoami, [], input.sessionDir],
    ['whoami /groups', whoami, ['/groups'], input.sessionDir],
    ['office profile read', path.win32.join(sys, 'cmd.exe'), ['/d', '/c', 'dir', input.protectedDir], input.sessionDir],
    ['cwd escape C:\\', whoami, [], input.escapeCwd ?? 'C:\\'],
  ];
  const probes: AgentIsolationProbe[] = [];
  for (const [label, exe, args, cwd] of plan)
    probes.push(await runProbe(input.spawnAs, label, exe, args, cwd, timeoutMs));
  const checks = evaluateAgentIsolationAcceptance(input.username, probes);
  return { username: input.username, probes, checks, passed: Object.values(checks).every(Boolean) };
}
