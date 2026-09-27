import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Provider } from '../shared/types.js';
import {
  findClaudeProject,
  findCodexRollout,
  findDevinSessionRows,
  providerRecordRoots,
  resolveDevinExecutable,
} from './local-provider-records.js';

/**
 * Provider-side session lifecycle for local mailbox packets — archive-only (QO-LOCAL-REV-20260919
 * §10, defects F01/F10). The office never deletes provider history itself: the only supported
 * per-session archive verb on this machine is `devin rm <id> --force`. Claude Code and Codex carry
 * no such verb in their installed CLIs, so they answer UNSUPPORTED and their records are preserved.
 *
 * Identity is exact: providerSessionId is the provider's own record identity — the sessions.db row
 * id for devin, the .claude/projects directory key for claude, the rollout file name for codex —
 * matching ProviderRecord.id from local-provider-records discovery. Nothing is prefix- or
 * substring-resolved, and a lookup that could match more than one record reports UNKNOWN with the
 * ambiguity named rather than picking one.
 */

export interface ProviderSessionBinding {
  provider: Provider;
  /** LocalSessionRecord.providerSessionId — the provider's exact record identity. */
  providerSessionId: string;
}

export const INSPECT_STATUSES = ['FOUND', 'MISSING', 'BUSY', 'UNSUPPORTED', 'UNKNOWN'] as const;
export type InspectStatus = (typeof INSPECT_STATUSES)[number];
export interface InspectOutcome {
  status: InspectStatus;
  detail: string;
}

export const ARCHIVE_STATUSES = ['ARCHIVED', 'ALREADY_ARCHIVED', 'BUSY', 'UNSUPPORTED', 'UNKNOWN'] as const;
export type ArchiveStatus = (typeof ARCHIVE_STATUSES)[number];
export interface ArchiveOutcome {
  status: ArchiveStatus;
  detail: string;
}

export interface ProviderLifecycle {
  inspect(binding: ProviderSessionBinding): Promise<InspectOutcome>;
  archive(binding: ProviderSessionBinding, operationId: string): Promise<ArchiveOutcome>;
}

/** One `devin rm <id> --force` invocation; injectable so tests never spawn a real CLI. */
export type DevinRmRunner = (sessionId: string) => Promise<{ ok: boolean; report: string }>;

export interface ProviderLifecycleDeps {
  /** %APPDATA%\devin\cli\sessions.db — absent means the store cannot be located at all. */
  sessionsDb?: string | null;
  /** %USERPROFILE%\.claude\projects — the per-cwd project record root. */
  claudeProjects?: string | null;
  /** %USERPROFILE%\.codex — sessions/ and archived_sessions/ live under it. */
  codexHome?: string | null;
  /** devin rm runner; absent when devin.exe could not be resolved. */
  devinRm?: DevinRmRunner | null;
  /** Injectable row lookup — tests fake busy/ambiguous stores without a locked sqlite file. */
  devinRows?: typeof findDevinSessionRows;
}

const BUSY_WORDING = /busy|in use|open in|another process|running|locked|still active/i;
const NOT_FOUND_WORDING = /not found|no such|does not exist|doesn't exist|unknown session|no session/i;

/** `devin rm <id> --force` against the resolved executable: arg array, bounded output, no shell. */
export function createDevinRmRunner(executable: string): DevinRmRunner {
  return sessionId =>
    new Promise(resolve => {
      execFile(
        executable,
        ['rm', sessionId, '--force'],
        { timeout: 30000, windowsHide: true, maxBuffer: 256 * 1024 },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ ok: true, report: String(stdout).trim().slice(0, 400) || 'devin rm reported success' });
            return;
          }
          const report =
            [stderr, stdout, error.message].map(text => String(text ?? '').trim()).find(text => text) ??
            'unknown failure';
          resolve({ ok: false, report: report.slice(0, 400) });
        },
      );
    });
}

/** The production wiring: real record roots and the real devin.exe, resolved exactly once here. */
export function createLocalProviderLifecycle(env: NodeJS.ProcessEnv = process.env): ProviderLifecycle {
  const roots = providerRecordRoots(env);
  const executable = resolveDevinExecutable(env);
  return createProviderLifecycle({
    sessionsDb: roots.sessionsDb,
    claudeProjects: roots.claudeProjects,
    codexHome: roots.codexHome,
    devinRm: executable ? createDevinRmRunner(executable) : null,
  });
}

export function createProviderLifecycle(deps: ProviderLifecycleDeps): ProviderLifecycle {
  const devinRows = deps.devinRows ?? findDevinSessionRows;

  function inspectDevin(sessionId: string): InspectOutcome {
    if (!deps.sessionsDb)
      return {
        status: 'UNKNOWN',
        detail: 'No APPDATA is set; the Devin sessions store cannot be located, so the binding cannot be inspected.',
      };
    if (!existsSync(deps.sessionsDb))
      return {
        status: 'MISSING',
        detail: `No Devin sessions store at ${deps.sessionsDb}; no provider-side session record can exist.`,
      };
    const { records, notes } = devinRows(deps.sessionsDb, sessionId);
    if (notes.length > 0) {
      const detail = notes.join(' ');
      return { status: BUSY_WORDING.test(detail) ? 'BUSY' : 'UNKNOWN', detail };
    }
    if (records.length === 0)
      return {
        status: 'MISSING',
        detail: `No sessions.db row carries the exact session id ${JSON.stringify(sessionId)}.`,
      };
    if (records.length > 1)
      return {
        status: 'UNKNOWN',
        detail: `${records.length} sessions.db rows carry the exact session id ${JSON.stringify(sessionId)}; the binding is ambiguous and nothing was distinguished.`,
      };
    const record = records[0];
    return {
      status: 'FOUND',
      detail: `sessions.db row ${record.id} (${record.detail || 'untitled'}) present at ${record.location}.`,
    };
  }

  function inspectClaude(projectKey: string): InspectOutcome {
    if (!deps.claudeProjects)
      return {
        status: 'UNKNOWN',
        detail:
          'No user profile directory is set; the Claude Code projects store cannot be located, so the binding cannot be inspected.',
      };
    if (!existsSync(deps.claudeProjects))
      return {
        status: 'MISSING',
        detail: `No Claude Code projects store at ${deps.claudeProjects}; no provider-side project record can exist.`,
      };
    const { records, notes } = findClaudeProject(deps.claudeProjects, projectKey);
    if (notes.length > 0) return { status: 'UNKNOWN', detail: notes.join(' ') };
    if (records.length === 0)
      return {
        status: 'MISSING',
        detail: `No project directory under ${deps.claudeProjects} carries the exact key ${JSON.stringify(projectKey)}.`,
      };
    if (records.length > 1)
      return {
        status: 'UNKNOWN',
        detail: `${records.length} project directories match the key ${JSON.stringify(projectKey)} (${records.map(r => r.id).join(', ')}); the binding is ambiguous and nothing was distinguished.`,
      };
    return { status: 'FOUND', detail: `Claude project ${records[0].id} present at ${records[0].location}.` };
  }

  function inspectCodex(fileName: string): InspectOutcome {
    if (!deps.codexHome)
      return {
        status: 'UNKNOWN',
        detail: 'No Codex home is set; the sessions store cannot be located, so the binding cannot be inspected.',
      };
    if (!existsSync(deps.codexHome))
      return {
        status: 'MISSING',
        detail: `No Codex sessions store at ${deps.codexHome}; no provider-side rollout can exist.`,
      };
    const { records, notes } = findCodexRollout(deps.codexHome, fileName);
    if (notes.length > 0) return { status: 'UNKNOWN', detail: notes.join(' ') };
    if (records.length === 0)
      return {
        status: 'MISSING',
        detail: `No rollout file named ${JSON.stringify(fileName)} under ${deps.codexHome} sessions/ or archived_sessions/.`,
      };
    if (records.length > 1)
      return {
        status: 'UNKNOWN',
        detail: `${records.length} rollout files carry the name ${JSON.stringify(fileName)} (${records.map(r => r.location).join(', ')}); the binding is ambiguous and nothing was distinguished.`,
      };
    return { status: 'FOUND', detail: `Codex rollout ${records[0].id} present at ${records[0].location}.` };
  }

  async function archiveDevin(sessionId: string, operationId: string): Promise<ArchiveOutcome> {
    const runner = deps.devinRm;
    if (!runner)
      return {
        status: 'UNKNOWN',
        detail: `operation ${operationId}: devin.exe could not be located; the provider-side record was not touched.`,
      };
    const { ok, report } = await runner(sessionId);
    if (ok) return { status: 'ARCHIVED', detail: `operation ${operationId}: ${report}` };
    // Order matters: a live session is the dangerous misclassification, so busy wording wins over
    // not-found wording if a tool report ever matched both.
    if (BUSY_WORDING.test(report))
      return { status: 'BUSY', detail: `operation ${operationId}: devin rm refused — ${report}` };
    if (NOT_FOUND_WORDING.test(report))
      return {
        status: 'ALREADY_ARCHIVED',
        detail: `operation ${operationId}: devin rm reported no such session (${report}); the provider-side record is already absent — archived earlier or never present.`,
      };
    return { status: 'UNKNOWN', detail: `operation ${operationId}: devin rm failed — ${report}` };
  }

  return {
    async inspect(binding) {
      switch (binding.provider) {
        case 'devin':
          return inspectDevin(binding.providerSessionId);
        case 'claude':
          return inspectClaude(binding.providerSessionId);
        case 'openai':
          return inspectCodex(binding.providerSessionId);
      }
    },
    async archive(binding, operationId) {
      switch (binding.provider) {
        case 'devin':
          return archiveDevin(binding.providerSessionId, operationId);
        case 'claude':
          return {
            status: 'UNSUPPORTED',
            detail: `operation ${operationId}: Claude Code carries no supported per-session archive verb in the installed CLI; provider history at ${deps.claudeProjects ?? '~/.claude/projects'} is preserved. Archiving would require an official claude archive/remove command; the office never deletes project directories.`,
          };
        case 'openai':
          return {
            status: 'UNSUPPORTED',
            detail: `operation ${operationId}: Codex carries no supported per-session archive verb in the installed CLI; provider history under ${deps.codexHome ?? '~/.codex'} is preserved. Archiving would require an official codex archive/remove command; the office never deletes rollout files.`,
          };
      }
    },
  };
}
