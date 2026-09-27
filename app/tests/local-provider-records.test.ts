import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { removeTreeSync } from '../src/main/fsx';
import {
  claudeProjectKey,
  discover,
  discoverClaudeProject,
  discoverCodexRollouts,
  discoverDevinSessions,
  findClaudeProject,
  findCodexRollout,
  findDevinSessionRows,
} from '../src/main/local-provider-records';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-provider-records-'));
  t.after(() => removeTreeSync(root));
  const packetDir = path.join(root, 'sessions', 'packet-one');
  mkdirSync(packetDir, { recursive: true });
  return { root, packetDir };
}

/** A fake Devin sessions store with the real table name and column shape. */
function sessionsDb(dir: string, rows: { id: string; working_directory: string; title?: string }[]): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sessions.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, working_directory TEXT, backend_type TEXT, model TEXT, agent_mode TEXT,
    created_at TEXT, last_activity_at TEXT, title TEXT)`);
  for (const row of rows)
    db.prepare('INSERT INTO sessions (id, working_directory, title) VALUES (?, ?, ?)').run(
      row.id,
      row.working_directory,
      row.title ?? null,
    );
  db.close();
  return file;
}

/** A fake Codex rollout carrying session_meta with a recorded cwd in its opening line. */
function rollout(file: string, cwd: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const meta = {
    timestamp: '2026-09-18T10:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'rollout-id', cwd, ...extra },
  };
  writeFileSync(file, `${JSON.stringify(meta)}\n${JSON.stringify({ type: 'user_message', message: 'work' })}\n`);
}

test('the claude project key mangles an observed cwd into the observed key shape', t => {
  fixture(t);
  // Inferred from observed key names: drive colon, separators and spaces each become a dash.
  assert.equal(
    claudeProjectKey('C:\\Users\\louis\\Desktop\\AI\\Quant Office'),
    'C--Users-louis-Desktop-AI-Quant-Office',
  );
  assert.equal(claudeProjectKey('C:/Users/louis/Desktop/AI/Quant Office'), 'C--Users-louis-Desktop-AI-Quant-Office');
});

test('claude discovery finds only the directory whose name equals the derived key', t => {
  const f = fixture(t);
  const projectsRoot = path.join(f.root, '.claude', 'projects');
  const key = claudeProjectKey(f.packetDir);
  mkdirSync(path.join(projectsRoot, key), { recursive: true });
  mkdirSync(path.join(projectsRoot, 'C--somewhere-else'), { recursive: true });
  const { records, notes } = discoverClaudeProject(projectsRoot, f.packetDir);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'claude-project');
  assert.equal(records[0].id, key);
  assert.equal(records[0].location, path.join(projectsRoot, key));
  assert.deepEqual(notes, []);
});

test('claude discovery on an absent projects store reports empty, never throws', t => {
  const f = fixture(t);
  const { records, notes } = discoverClaudeProject(path.join(f.root, 'no-such-root'), f.packetDir);
  assert.deepEqual(records, []);
  assert.equal(notes.length, 1);
});

test('claude exact-key lookup matches the project dir by name only', t => {
  const f = fixture(t);
  const projectsRoot = path.join(f.root, '.claude', 'projects');
  const key = claudeProjectKey(f.packetDir);
  mkdirSync(path.join(projectsRoot, key, 'nested'), { recursive: true });
  mkdirSync(path.join(projectsRoot, 'C--somewhere-else'), { recursive: true });
  const { records, notes } = findClaudeProject(projectsRoot, key);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, key);
  assert.equal(records[0].location, path.join(projectsRoot, key));
  assert.deepEqual(notes, []);
  // The project dir is still there: lookup is read-only.
  assert.ok(existsSync(path.join(projectsRoot, key)));
  assert.equal(findClaudeProject(projectsRoot, 'no-such-key').records.length, 0);
  assert.equal(findClaudeProject(projectsRoot, '../escape').records.length, 0);
});

test('devin discovery reads sessions.db read-only and matches both separator forms', t => {
  const f = fixture(t);
  const dbFile = sessionsDb(path.join(f.root, 'devin', 'cli'), [
    { id: 'mulberry-ferry', working_directory: f.packetDir, title: 'Mulberry Ferry' },
    { id: 'slashy-id', working_directory: f.packetDir.replaceAll('\\', '/'), title: 'Slash form' },
    { id: 'other', working_directory: path.join(f.root, 'elsewhere'), title: 'Elsewhere' },
  ]);
  const before = readFileSync(dbFile);
  const { records } = discoverDevinSessions(dbFile, f.packetDir);
  assert.deepEqual(records.map(r => r.id).sort(), ['mulberry-ferry', 'slashy-id']);
  assert.deepEqual(readFileSync(dbFile), before, 'discovery never writes to sessions.db');
});

test('devin discovery on an absent or unopenable store reports honestly', t => {
  const f = fixture(t);
  const absent = discoverDevinSessions(path.join(f.root, 'missing.db'), f.packetDir);
  assert.deepEqual(absent.records, []);
  assert.match(absent.notes[0], /No Devin sessions store/);
  const notDb = path.join(f.root, 'not-a-db');
  writeFileSync(notDb, 'plain text, not sqlite');
  const broken = discoverDevinSessions(notDb, f.packetDir);
  assert.deepEqual(broken.records, []);
  assert.equal(broken.notes.length, 1);
});

test('devin exact-id lookup returns rows for that id only, read-only', t => {
  const f = fixture(t);
  const dbFile = sessionsDb(path.join(f.root, 'devin', 'cli'), [
    { id: 'mulberry-ferry', working_directory: f.packetDir, title: 'Mulberry Ferry' },
    { id: 'other', working_directory: path.join(f.root, 'elsewhere'), title: 'Elsewhere' },
  ]);
  const before = readFileSync(dbFile);
  const { records, notes } = findDevinSessionRows(dbFile, 'mulberry-ferry');
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'mulberry-ferry');
  assert.equal(records[0].detail, 'Mulberry Ferry');
  assert.deepEqual(notes, []);
  assert.deepEqual(readFileSync(dbFile), before, 'lookup never writes to sessions.db');
  assert.equal(findDevinSessionRows(dbFile, 'mulb').records.length, 0, 'no prefix matching');
});

test('codex discovery matches rollouts by recorded cwd across sessions and archived_sessions', t => {
  const f = fixture(t);
  const codexRoot = path.join(f.root, '.codex');
  const live = path.join(codexRoot, 'sessions', '2026', '09', '18', 'rollout-2026-09-18T10-00-00-aaaa.jsonl');
  const archived = path.join(
    codexRoot,
    'archived_sessions',
    '2026',
    '09',
    '17',
    'rollout-2026-09-17T09-00-00-bbbb.jsonl',
  );
  rollout(live, f.packetDir);
  rollout(archived, f.packetDir.toLowerCase().replaceAll('\\', '/')); // case/separator drift still binds
  const { records } = discoverCodexRollouts(codexRoot, f.packetDir);
  assert.deepEqual(records.map(r => r.id).sort(), [
    'rollout-2026-09-17T09-00-00-bbbb.jsonl',
    'rollout-2026-09-18T10-00-00-aaaa.jsonl',
  ]);
});

test('codex discovery reports unparseable rollouts and never guesses at them', t => {
  const f = fixture(t);
  const codexRoot = path.join(f.root, '.codex');
  const good = path.join(codexRoot, 'sessions', '2026', '09', '18', 'rollout-good.jsonl');
  const bad = path.join(codexRoot, 'sessions', '2026', '09', '18', 'rollout-bad.jsonl');
  rollout(good, f.packetDir);
  mkdirSync(path.dirname(bad), { recursive: true });
  writeFileSync(bad, 'not json {\nno metadata here\n');
  const { records, notes } = discoverCodexRollouts(codexRoot, f.packetDir);
  assert.deepEqual(
    records.map(r => r.id),
    ['rollout-good.jsonl'],
  );
  assert.match(notes.join('\n'), /rollout-bad\.jsonl carries no readable session cwd/);
});

test('codex exact-name lookup matches rollout file names only, across both record dirs', t => {
  const f = fixture(t);
  const codexRoot = path.join(f.root, '.codex');
  const live = path.join(codexRoot, 'sessions', '2026', '09', '18', 'rollout-2026-09-18T10-00-00-aaaa.jsonl');
  const other = path.join(codexRoot, 'sessions', '2026', '09', '18', 'rollout-2026-09-18T10-00-00-bbbb.jsonl');
  rollout(live, f.packetDir);
  rollout(other, path.join(f.root, 'different', 'dir'));
  const { records } = findCodexRollout(codexRoot, 'rollout-2026-09-18T10-00-00-aaaa.jsonl');
  assert.equal(records.length, 1);
  assert.equal(records[0].location, live);
  assert.ok(existsSync(live), 'lookup is read-only');
  assert.equal(
    findCodexRollout(codexRoot, 'rollout-2026-09-18T10-00-00-aaaa').records.length,
    0,
    'no partial-name matching',
  );
  assert.equal(findCodexRollout(codexRoot, '..\\rollout-x.jsonl').records.length, 0, 'a non-basename is refused');
});

test('the codex scan honors the file-count bound and says so', t => {
  const f = fixture(t);
  const codexRoot = path.join(f.root, '.codex');
  rollout(path.join(codexRoot, 'sessions', '2026', '09', '18', 'rollout-a.jsonl'), f.packetDir);
  rollout(path.join(codexRoot, 'sessions', '2026', '09', '18', 'rollout-b.jsonl'), f.packetDir);
  const { records, notes } = discoverCodexRollouts(codexRoot, f.packetDir, { maxFiles: 1 });
  assert.ok(records.length <= 1);
  assert.match(notes.join('\n'), /stopped at the 1-file bound/);
});

test('the top level resolves roots from env and discovers each provider through its own path', t => {
  const f = fixture(t);
  const home = path.join(f.root, 'home');
  const appdata = path.join(f.root, 'appdata');
  const codexHome = path.join(f.root, 'codex-home');
  // claude: fake projects store under the fake profile.
  const key = claudeProjectKey(f.packetDir);
  mkdirSync(path.join(home, '.claude', 'projects', key), { recursive: true });
  // devin: fake sessions.db under the fake APPDATA.
  sessionsDb(path.join(appdata, 'devin', 'cli'), [{ id: 'mulberry-ferry', working_directory: f.packetDir }]);
  // codex: fake rollout under the fake CODEX_HOME.
  rollout(path.join(codexHome, 'sessions', '2026', '09', '18', 'rollout-mine.jsonl'), f.packetDir);
  const env = { USERPROFILE: home, APPDATA: appdata, CODEX_HOME: codexHome };
  assert.equal(discover(f.packetDir, 'claude', env).records.length, 1);
  assert.equal(discover(f.packetDir, 'devin', env).records.length, 1);
  assert.equal(discover(f.packetDir, 'openai', env).records.length, 1);
  // Everything is still in place: discovery is a diagnostic read, never a removal.
  assert.ok(existsSync(path.join(home, '.claude', 'projects', key)));
  assert.ok(existsSync(path.join(codexHome, 'sessions', '2026', '09', '18', 'rollout-mine.jsonl')));
});
