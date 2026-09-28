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
