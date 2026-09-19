import { closeSync, existsSync, openSync, readSync, readdirSync, type Dirent } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { Provider } from '../shared/types.js';

/**
 * Provider-side session records for local mailbox packets — READ-ONLY diagnostics.
 *
 * Three stores track the same work and never propagate deletes: the office database, the packet
 * directory under the workspace sessions root, and the provider's own session records. Retiring a
 * packet leaves the provider record behind; this module maps a packet directory or an exact
 * provider identity to those records. Nothing here removes provider bytes — supported lifecycle
 * operations (devin's `devin rm <id> --force`, the only per-session archive verb the installed
 * CLIs carry) live in local-provider-lifecycle.ts. Claude project dirs and Codex rollout files are
 * never deleted by this codebase: no supported per-session removal exists for them, and raw file
 * deletion is exactly defects F01/F10.
 *
 * Verified record locations on this machine:
 * - Devin CLI/Desktop sessions: %APPDATA%\devin\cli\sessions.db, table `sessions` with
 *   id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title.
 *   The DB is opened read-only — never written.
 * - Claude Code projects: %USERPROFILE%\.claude\projects\<key>\ where <key> is derived from the
 *   recorded working directory — see claudeProjectKey. The transform is inferred from observed key
 *   names and is documented as such.
 * - Codex sessions: %USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-<timestamp>-<uuid>.jsonl
 *   (and already-archived ones under %USERPROFILE%\.codex\archived_sessions\). A rollout's opening
 *   lines carry session metadata including cwd; matching means scanning each file's first chunk.
 *
 * Absent stores and missing tools report empty or honest failures — they never throw.
 */

export interface ProviderRecord {
  provider: Provider;
  kind: 'devin-session' | 'claude-project' | 'codex-rollout';
  /** The provider's own identity for the record: session id, project key or rollout file name. */
  id: string;
  /** Human detail from the record: session title or the recorded working directory. */
  detail: string;
  /** Where the record lives: the sessions.db path, project directory or rollout file. */
  location: string;
}

/** What a discovery pass found, plus anything it could see but not honestly classify. */
export interface Discovery { records: ProviderRecord[]; notes: string[] }

const msg = (error: unknown): string => error instanceof Error ? error.message : 'unknown error';
/** Absolute, separator-stable, case-insensitive comparison key for recorded working directories. */
const normDir = (dir: string): string => path.resolve(dir).replace(/\\/g, '/').toLowerCase();

const DEVIN_SESSIONS_DB = path.join('devin', 'cli', 'sessions.db');
const CLAUDE_PROJECTS = path.join('.claude', 'projects');
const CODEX_HOME_DIR = '.codex';
const CODEX_RECORD_DIRS = ['sessions', 'archived_sessions'] as const;
const ROLLOUT_FILE = /^rollout-.+\.jsonl$/i;
/** Bounded scan: a rollout's session metadata is in its opening lines, never deeper. */
const MAX_ROLLOUT_FILES = 2048;
const MAX_ROLLOUT_HEAD = 64 * 1024;
const MAX_SCAN_DEPTH = 6;

/**
 * The .claude/projects key Claude Code derives from a working directory, inferred from observed
 * key names on this machine: the drive colon, every path separator and every space each become a
 * dash — 'C:\Users\louis\Desktop\AI\Quant Office' → 'C--Users-louis-Desktop-AI-Quant-Office'.
 */
export function claudeProjectKey(dir: string): string {
  return path.resolve(dir).replace(/[:\\/\s]/g, '-');
}

/** Devin sessions.db rows bound to a working directory. Read-only — this file is never written. */
export function discoverDevinSessions(sessionsDbPath: string, packetDir: string): Discovery {
  if (!existsSync(sessionsDbPath)) return { records: [], notes: [`No Devin sessions store at ${sessionsDbPath}.`] };
  // Windows path spellings vary; match both the raw form and path-normalized forms.
  const forms = [...new Set([packetDir, path.resolve(packetDir), path.resolve(packetDir).replaceAll('\\', '/')])];
  let db: DatabaseSync;
  try { db = new DatabaseSync(sessionsDbPath, { readOnly: true }); }
  catch (error) { return { records: [], notes: [`The Devin sessions store could not be opened read-only: ${msg(error)}`] }; }
  try {
    const stmt = db.prepare('SELECT id, title, working_directory FROM sessions WHERE working_directory = ?');
    const seen = new Set<string>();
    const records: ProviderRecord[] = [];
    for (const form of forms) {
      for (const row of stmt.all(form) as { id: string; title: string; working_directory: string }[]) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        records.push({ provider: 'devin', kind: 'devin-session', id: row.id, detail: row.title ?? '', location: sessionsDbPath });
      }
    }
    return { records, notes: [] };
  } catch (error) {
    return { records: [], notes: [`The Devin sessions store could not be read: ${msg(error)}`] };
  } finally { db.close(); }
}

/** The .claude/projects directory whose name equals the derived key — nothing else is ever named. */
export function discoverClaudeProject(projectsRoot: string, packetDir: string): Discovery {
  if (!existsSync(projectsRoot)) return { records: [], notes: [`No Claude Code projects store at ${projectsRoot}.`] };
  const key = claudeProjectKey(packetDir);
  if (!key || key === '.' || key === '..' || key.includes('/') || key.includes('\\'))
    return { records: [], notes: [`The derived project key ${JSON.stringify(key)} is not a safe directory name; nothing was matched.`] };
  let entries: string[];
  try { entries = readdirSync(projectsRoot); }
  catch (error) { return { records: [], notes: [`The Claude Code projects store could not be listed: ${msg(error)}`] }; }
  // Case-insensitive name equality: Windows directory names compare without case, and the stored
  // key keeps the case of whatever cwd the tool recorded.
  const matched = entries.filter(entry => entry.toLowerCase() === key.toLowerCase());
  return {
    records: matched.map(entry => ({ provider: 'claude', kind: 'claude-project', id: entry, detail: path.resolve(packetDir), location: path.join(projectsRoot, entry) })),
    notes: [],
  };
}

function collectRollouts(dir: string, depth: number, files: string[], cap: number): void {
  if (files.length >= cap || depth > MAX_SCAN_DEPTH) return;
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (files.length >= cap) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectRollouts(full, depth + 1, files, cap);
    else if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) files.push(full);
  }
}

/** The recorded cwd from a rollout's opening lines, or null when the head carries none. */
function rolloutCwd(file: string, headBytes: number): string | null {
  let head: string;
  try {
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(headBytes);
      const read = readSync(fd, buffer, 0, headBytes, 0);
      head = buffer.subarray(0, read).toString('utf8');
    } finally { closeSync(fd); }
  } catch { return null; }
  for (const line of head.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : undefined;
    const cwd = payload?.cwd ?? record.cwd;
    if (typeof cwd === 'string' && cwd) return cwd;
  }
  return null;
}

/** Rollout files under sessions/ and archived_sessions/ whose recorded cwd is the packet dir. */
export function discoverCodexRollouts(codexRoot: string, packetDir: string, bounds: { maxFiles?: number; headBytes?: number } = {}): Discovery {
  const maxFiles = bounds.maxFiles ?? MAX_ROLLOUT_FILES;
  const headBytes = bounds.headBytes ?? MAX_ROLLOUT_HEAD;
  const target = normDir(packetDir);
  const notes: string[] = [];
  const files: string[] = [];
  for (const sub of CODEX_RECORD_DIRS) {
    if (files.length >= maxFiles) break;
    const base = path.join(codexRoot, sub);
    if (existsSync(base)) collectRollouts(base, 0, files, maxFiles);
  }
  if (!existsSync(codexRoot)) notes.push(`No Codex sessions store at ${codexRoot}.`);
  else if (files.length >= maxFiles) notes.push(`The rollout scan stopped at the ${maxFiles}-file bound; records beyond it were not inspected.`);
  const records: ProviderRecord[] = [];
  for (const file of files) {
    const cwd = rolloutCwd(file, headBytes);
    if (cwd === null) {
      notes.push(`rollout ${path.basename(file)} carries no readable session cwd in its first ${headBytes} bytes; left alone rather than guessed`);
      continue;
    }
    if (normDir(cwd) !== target) continue;
    records.push({ provider: 'openai', kind: 'codex-rollout', id: path.basename(file), detail: cwd, location: file });
  }
  return { records, notes };
}

/**
 * sessions.db rows whose id equals the session id exactly — never prefix- or substring-matched.
 * More than one row means a corrupt or unexpected store; the caller must report ambiguity rather
 * than pick one. Read-only — this file is never written.
 */
export function findDevinSessionRows(sessionsDbPath: string, sessionId: string): Discovery {
  if (!existsSync(sessionsDbPath)) return { records: [], notes: [`No Devin sessions store at ${sessionsDbPath}.`] };
  let db: DatabaseSync;
  try { db = new DatabaseSync(sessionsDbPath, { readOnly: true }); }
  catch (error) { return { records: [], notes: [`The Devin sessions store could not be opened read-only: ${msg(error)}`] }; }
  try {
    const rows = db.prepare('SELECT id, title, working_directory FROM sessions WHERE id = ?')
      .all(sessionId) as { id: string; title: string; working_directory: string }[];
    return {
      records: rows.map(row => ({ provider: 'devin', kind: 'devin-session', id: row.id, detail: row.title ?? '', location: sessionsDbPath })),
      notes: [],
    };
  } catch (error) {
    return { records: [], notes: [`The Devin sessions store could not be read: ${msg(error)}`] };
  } finally { db.close(); }
}

/** The .claude/projects directory whose name equals the given key exactly — no derivation here. */
export function findClaudeProject(projectsRoot: string, projectKey: string): Discovery {
  if (!existsSync(projectsRoot)) return { records: [], notes: [`No Claude Code projects store at ${projectsRoot}.`] };
  if (!projectKey || projectKey === '.' || projectKey === '..' || projectKey.includes('/') || projectKey.includes('\\'))
    return { records: [], notes: [`The project key ${JSON.stringify(projectKey)} is not a safe directory name; nothing was matched.`] };
  let entries: string[];
  try { entries = readdirSync(projectsRoot); }
  catch (error) { return { records: [], notes: [`The Claude Code projects store could not be listed: ${msg(error)}`] }; }
  const matched = entries.filter(entry => entry.toLowerCase() === projectKey.toLowerCase());
  return {
    records: matched.map(entry => ({ provider: 'claude', kind: 'claude-project', id: entry, detail: entry, location: path.join(projectsRoot, entry) })),
    notes: [],
  };
}

/** Rollout files under sessions/ and archived_sessions/ whose file name equals the given name exactly. */
export function findCodexRollout(codexRoot: string, fileName: string, bounds: { maxFiles?: number } = {}): Discovery {
  const maxFiles = bounds.maxFiles ?? MAX_ROLLOUT_FILES;
  const notes: string[] = [];
  if (!fileName || fileName !== path.basename(fileName) || !ROLLOUT_FILE.test(fileName))
    return { records: [], notes: [`${JSON.stringify(fileName)} is not a rollout file name; nothing was matched.`] };
  const files: string[] = [];
  for (const sub of CODEX_RECORD_DIRS) {
    if (files.length >= maxFiles) break;
    const base = path.join(codexRoot, sub);
    if (existsSync(base)) collectRollouts(base, 0, files, maxFiles);
  }
  if (!existsSync(codexRoot)) notes.push(`No Codex sessions store at ${codexRoot}.`);
  else if (files.length >= maxFiles) notes.push(`The rollout scan stopped at the ${maxFiles}-file bound; files beyond it were not inspected.`);
  const wanted = fileName.toLowerCase();
  return {
    records: files
      .filter(file => path.basename(file).toLowerCase() === wanted)
      .map(file => ({ provider: 'openai', kind: 'codex-rollout', id: path.basename(file), detail: file, location: file })),
    notes,
  };
}

/**
 * The official devin.exe the office would run, resolved in the same style as
 * subscriptions.ts: PATH entries, the user-local bin and the desktop install root.
 */
export function resolveDevinExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = 'devin.exe';
  const candidates = (env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name));
  if (env.USERPROFILE) candidates.push(path.join(env.USERPROFILE, '.local', 'bin', name));
  if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Devin', name));
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

/** The real per-provider record roots, resolved from the user's environment. */
export function providerRecordRoots(env: NodeJS.ProcessEnv = process.env): { sessionsDb: string | null; claudeProjects: string | null; codexHome: string | null } {
  const home = env.USERPROFILE ?? env.HOME;
  return {
    sessionsDb: env.APPDATA ? path.join(env.APPDATA, DEVIN_SESSIONS_DB) : null,
    claudeProjects: home ? path.join(home, CLAUDE_PROJECTS) : null,
    codexHome: env.CODEX_HOME ?? (home ? path.join(home, CODEX_HOME_DIR) : null),
  };
}

/** Records bound to a packet dir's cwd, for one provider. Absent stores report empty. */
export function discover(packetDir: string, provider: Provider, env: NodeJS.ProcessEnv = process.env): Discovery {
  const roots = providerRecordRoots(env);
  switch (provider) {
    case 'devin': return roots.sessionsDb ? discoverDevinSessions(roots.sessionsDb, packetDir) : { records: [], notes: ['No APPDATA is set; the Devin sessions store cannot be located.'] };
    case 'claude': return roots.claudeProjects ? discoverClaudeProject(roots.claudeProjects, packetDir) : { records: [], notes: ['No user profile directory is set; the Claude Code projects store cannot be located.'] };
    case 'openai': return roots.codexHome ? discoverCodexRollouts(roots.codexHome, packetDir) : { records: [], notes: ['No user profile directory is set; the Codex sessions store cannot be located.'] };
  }
}
